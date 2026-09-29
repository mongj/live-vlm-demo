export type ThumbnailResult = { status: "loaded"; objectUrl: string; durationMs: number | null } | { status: "failed" };

/** Visible cards load before cards that are only within the margin. */
type Demand = "visible" | "near";

type Watcher = { url: string; visible: boolean; near: boolean };

type Job = {
  url: string;
  demand: Demand;
  /** Order in which the job last gained its current demand; earlier goes first. */
  order: number;
  /** Cards scrolled past within `DWELL_MS` never reach the queue. */
  ready: boolean;
  dwellTimer: number | null;
  controller: AbortController | null;
};

type RootObservers = { near: IntersectionObserver; visible: IntersectionObserver; count: number };

const MAX_CONCURRENT = 4;
const DWELL_MS = 120;
const NEAR_MARGIN = "200px 0px";
const DURATION_HEADER = "X-Video-Duration-Ms";

function demandRank(demand: Demand): number {
  switch (demand) {
    case "visible":
      return 0;
    case "near":
      return 1;
    default: {
      const exhaustive: never = demand;
      return exhaustive;
    }
  }
}

function parseDuration(value: string | null): number | null {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Fetches gateway thumbnails only for cards near the scroll viewport, visible ones first, at most
 * `MAX_CONCURRENT` at a time. Requests for cards that scroll away are aborted. Results are kept as
 * object URLs for the rest of the session.
 */
class ThumbnailLoader {
  private readonly results = new Map<string, ThumbnailResult>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly watchers = new Map<Element, Watcher>();
  private readonly observers = new Map<Element, RootObservers>();
  private readonly jobs = new Map<string, Job>();
  private active = 0;
  private sequence = 0;

  getResult(url: string): ThumbnailResult | undefined {
    return this.results.get(url);
  }

  subscribe(url: string, listener: () => void): () => void {
    let set = this.listeners.get(url);
    if (!set) {
      set = new Set();
      this.listeners.set(url, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(url);
      }
    };
  }

  /** Loads `url` while `element` is within the margin of `root`, until the returned cleanup runs. */
  watch(element: Element, root: Element, url: string): () => void {
    if (this.results.has(url)) {
      return () => undefined;
    }
    const observers = this.observersFor(root);
    this.watchers.set(element, { url, visible: false, near: false });
    observers.near.observe(element);
    observers.visible.observe(element);
    return () => {
      observers.near.unobserve(element);
      observers.visible.unobserve(element);
      this.watchers.delete(element);
      this.releaseObservers(root);
      this.refreshDemand(url);
    };
  }

  private observersFor(root: Element): RootObservers {
    let observers = this.observers.get(root);
    if (!observers) {
      const update = (key: "near" | "visible") => (entries: IntersectionObserverEntry[]) => {
        const urls = new Set<string>();
        for (const entry of entries) {
          const watcher = this.watchers.get(entry.target);
          if (watcher) {
            watcher[key] = entry.isIntersecting;
            urls.add(watcher.url);
          }
        }
        urls.forEach((url) => this.refreshDemand(url));
      };
      observers = {
        near: new IntersectionObserver(update("near"), { root, rootMargin: NEAR_MARGIN }),
        visible: new IntersectionObserver(update("visible"), { root }),
        count: 0,
      };
      this.observers.set(root, observers);
    }
    observers.count += 1;
    return observers;
  }

  private releaseObservers(root: Element) {
    const observers = this.observers.get(root);
    if (observers && --observers.count === 0) {
      observers.near.disconnect();
      observers.visible.disconnect();
      this.observers.delete(root);
    }
  }

  private demandFor(url: string): Demand | null {
    let demand: Demand | null = null;
    for (const watcher of this.watchers.values()) {
      if (watcher.url !== url) {
        continue;
      }
      if (watcher.visible) {
        return "visible";
      }
      if (watcher.near) {
        demand = "near";
      }
    }
    return demand;
  }

  private refreshDemand(url: string) {
    if (this.results.has(url)) {
      return;
    }
    const demand = this.demandFor(url);
    const job = this.jobs.get(url);
    if (demand === null) {
      if (job) {
        job.controller?.abort();
        if (job.dwellTimer !== null) {
          window.clearTimeout(job.dwellTimer);
        }
        this.jobs.delete(url);
      }
      return;
    }
    if (!job) {
      const created: Job = { url, demand, order: this.sequence++, ready: false, dwellTimer: null, controller: null };
      created.dwellTimer = window.setTimeout(() => {
        created.dwellTimer = null;
        created.ready = true;
        this.pump();
      }, DWELL_MS);
      this.jobs.set(url, created);
    } else if (job.demand !== demand) {
      job.demand = demand;
      job.order = this.sequence++;
    }
    this.pump();
  }

  private nextQueued(): Job | undefined {
    let best: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.controller || !job.ready) {
        continue;
      }
      if (
        !best ||
        demandRank(job.demand) < demandRank(best.demand) ||
        (job.demand === best.demand && job.order < best.order)
      ) {
        best = job;
      }
    }
    return best;
  }

  private pump() {
    while (this.active < MAX_CONCURRENT) {
      const job = this.nextQueued();
      if (!job) {
        return;
      }
      void this.run(job);
    }
  }

  private async run(job: Job) {
    const controller = new AbortController();
    job.controller = controller;
    this.active += 1;
    try {
      const response = await fetch(job.url, { signal: controller.signal });
      if (response.ok) {
        const blob = await response.blob();
        this.settle(job.url, {
          status: "loaded",
          objectUrl: URL.createObjectURL(blob),
          durationMs: parseDuration(response.headers.get(DURATION_HEADER)),
        });
      } else if (response.status >= 400 && response.status < 500) {
        this.settle(job.url, { status: "failed" });
      }
    } catch {
      // Aborted, or the gateway was unreachable; the card retries the next time it scrolls into view.
    } finally {
      this.active -= 1;
      if (this.jobs.get(job.url) === job) {
        this.jobs.delete(job.url);
      }
      this.pump();
    }
  }

  private settle(url: string, result: ThumbnailResult) {
    this.results.set(url, result);
    this.listeners.get(url)?.forEach((listener) => listener());
  }
}

let sharedLoader: ThumbnailLoader | null = null;

export function getThumbnailLoader(): ThumbnailLoader {
  sharedLoader ??= new ThumbnailLoader();
  return sharedLoader;
}

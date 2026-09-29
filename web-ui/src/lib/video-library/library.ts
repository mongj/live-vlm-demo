import { LocalVideoProvider } from "@/lib/video-library/local-provider";
import {
  videoKey,
  type ReleasableUrl,
  type SaveOptions,
  type VideoPlayback,
  type VideoProvider,
  type VideoOrigin,
  type VideoProviderId,
  type VideoRecord,
  type VideoRef,
} from "@/lib/video-library/types";

const PROBE_TIMEOUT_MS = 10_000;
const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_POSITION = 0.1;
const THUMBNAIL_TYPE = "image/jpeg";
const THUMBNAIL_QUALITY = 0.8;

export type VideoListResult = {
  videos: VideoRecord[];
  /** Providers that failed to list; the other providers' videos are still returned. */
  failures: { providerId: VideoProviderId; message: string }[];
};

export type UploadOptions = SaveOptions & { origin?: VideoOrigin };

type ProbeResult = { playable: true; durationMs: number | null; thumbnail: Blob | null } | { playable: false };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function drawThumbnail(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) {
    return Promise.resolve(null);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(THUMBNAIL_WIDTH, video.videoWidth);
  canvas.height = Math.round((canvas.width / video.videoWidth) * video.videoHeight);
  const context = canvas.getContext("2d");
  if (!context) {
    return Promise.resolve(null);
  }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, THUMBNAIL_TYPE, THUMBNAIL_QUALITY));
}

/** Checks that the browser can play `url`, reads its duration, and captures a thumbnail frame. */
function probeVideo(url: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    let durationMs: number | null | undefined;
    const finish = (result: ProbeResult) => {
      window.clearTimeout(timeoutId);
      video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(result);
    };
    const capture = () => {
      void drawThumbnail(video)
        .catch(() => null)
        .then((thumbnail) => finish({ playable: true, durationMs: durationMs ?? null, thumbnail }));
    };
    const timeoutId = window.setTimeout(
      () => finish(durationMs === undefined ? { playable: false } : { playable: true, durationMs, thumbnail: null }),
      PROBE_TIMEOUT_MS
    );
    video.preload = "auto";
    video.muted = true;
    video.onloadedmetadata = () => {
      // MediaRecorder WebM files report an Infinity duration until fully scanned.
      const seconds = video.duration;
      durationMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
      if (durationMs) {
        video.onseeked = capture;
        video.currentTime = seconds * THUMBNAIL_POSITION;
      } else {
        video.onloadeddata = capture;
      }
    };
    video.onerror = () =>
      finish(durationMs === undefined ? { playable: false } : { playable: true, durationMs, thumbnail: null });
    video.src = url;
  });
}

async function probeBlob(blob: Blob): Promise<ProbeResult> {
  const url = URL.createObjectURL(blob);
  try {
    return await probeVideo(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class VideoLibrary {
  private readonly providers: Map<VideoProviderId, VideoProvider>;
  private readonly thumbnailBackfills = new Map<string, Promise<void>>();
  private backfillQueue: Promise<void> = Promise.resolve();

  constructor(providers: VideoProvider[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  private provider(id: VideoProviderId): VideoProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Unknown video provider: ${id}`);
    }
    return provider;
  }

  providerLabel(id: VideoProviderId): string {
    return this.providers.get(id)?.label ?? id;
  }

  /** The provider new uploads go to: the first one that accepts writes. */
  get uploadTarget(): VideoProvider | undefined {
    return [...this.providers.values()].find((provider) => provider.save);
  }

  canRemove(video: VideoRef): boolean {
    return Boolean(this.providers.get(video.providerId)?.remove);
  }

  async list(): Promise<VideoListResult> {
    const providers = [...this.providers.values()];
    const settled = await Promise.allSettled(providers.map((provider) => provider.list()));
    const videos: VideoRecord[] = [];
    const failures: VideoListResult["failures"] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        videos.push(...result.value);
      } else {
        failures.push({
          providerId: providers[index].id,
          message: errorMessage(result.reason, "Unable to list videos"),
        });
      }
    });
    videos.sort((a, b) => b.createdAt - a.createdAt);
    return { videos, failures };
  }

  open(video: VideoRef): Promise<VideoPlayback> {
    return this.provider(video.providerId).open(video.id);
  }

  /** Generates and stores a missing thumbnail on first request, when the provider accepts one. */
  async openThumbnail(video: VideoRef): Promise<ReleasableUrl | null> {
    const provider = this.provider(video.providerId);
    const existing = (await provider.openThumbnail?.(video.id)) ?? null;
    if (existing || !provider.saveThumbnail) {
      return existing;
    }
    await this.backfillThumbnail(provider, video);
    return (await provider.openThumbnail?.(video.id)) ?? null;
  }

  /** One probe at a time, and at most one attempt per video per session. */
  private backfillThumbnail(provider: VideoProvider, video: VideoRef): Promise<void> {
    const key = videoKey(video);
    let pending = this.thumbnailBackfills.get(key);
    if (!pending) {
      pending = this.backfillQueue.then(async () => {
        const playback = await provider.open(video.id);
        try {
          const probe = await probeVideo(playback.url);
          if (probe.playable && probe.thumbnail) {
            await provider.saveThumbnail?.(video.id, probe.thumbnail);
          }
        } finally {
          playback.release();
        }
      });
      pending = pending.catch(() => undefined);
      this.backfillQueue = pending;
      this.thumbnailBackfills.set(key, pending);
    }
    return pending;
  }

  async upload(file: File, { origin, ...options }: UploadOptions = {}): Promise<VideoRecord> {
    const target = this.uploadTarget;
    if (!target?.save) {
      throw new Error("No video storage accepts uploads");
    }
    if (file.type && !file.type.startsWith("video/")) {
      throw new Error(`${file.name} is not a video file`);
    }
    const probe = await probeBlob(file);
    if (!probe.playable) {
      throw new Error(`The browser cannot play ${file.name}`);
    }
    options.signal?.throwIfAborted();
    return target.save(
      {
        blob: file,
        name: file.name,
        mimeType: file.type || "video/*",
        durationMs: probe.durationMs,
        thumbnail: probe.thumbnail,
        origin,
      },
      options
    );
  }

  async remove(video: VideoRef): Promise<void> {
    const provider = this.provider(video.providerId);
    if (!provider.remove) {
      throw new Error(`${provider.label} videos cannot be deleted from the playground`);
    }
    await provider.remove(video.id);
  }
}

let sharedLibrary: VideoLibrary | null = null;

/** Register remote providers here; the first provider with `save` receives uploads. */
export function getVideoLibrary(): VideoLibrary {
  if (!sharedLibrary) {
    sharedLibrary = new VideoLibrary([new LocalVideoProvider()]);
  }
  return sharedLibrary;
}

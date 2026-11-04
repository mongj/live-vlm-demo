/** Causal left-to-right step tracker over the model's own sentences.
 * Uses only the supplied step list and reply text, never reference times.
 * A step here is an estimate from model output, not proof that it happened.
 */

const STOP = new Set(("a an and are as at be but by for from has have i in into is it its just let me my next no not now of on "
  + "once or our over so some that the then this to up us we will with you your all more out get make").split(" "));

/** Frozen settings from the development videos; do not retune on test clips. */
export const TRACKER_PARAMS = Object.freeze({mu:25, shape:1.0, hit:0.7, near:0.15, tau:0.4, mapTau:0.34});

/** Settings for saying listed steps, chosen on the same videos for that rule. */
export const LEAD_PARAMS = Object.freeze({mu:45, shape:1.0, hit:0.7, near:0.15, tau:0.5, mapTau:0.34});

/** @param {string} text @returns {Set<string>} */
export function contentWords(text) {
  const out = new Set();
  for (let word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (STOP.has(word) || word.length < 3) continue;
    for (const suffix of ["ing", "ed", "es", "s"]) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        word = word.slice(0, -suffix.length);
        break;
      }
    }
    out.add(word);
  }
  return out;
}

/** Substring test on squeezed text, because streamed text can lose spaces.
 * @param {string} text @param {readonly string[]} steps @param {number} [tau] @returns {number|null}
 */
export function closestStep(text, steps, tau = TRACKER_PARAMS.mapTau) {
  const squeezed = text.toLowerCase().replace(/[^a-z]/g, "");
  let best = null;
  let score = 0;
  steps.forEach((step, index) => {
    const words = contentWords(step);
    if (!words.size) return;
    let hits = 0;
    for (const word of words) if (squeezed.includes(word)) hits++;
    const hit = hits / words.size;
    if (hit > score) {
      best = index;
      score = hit;
    }
  });
  return score >= tau ? best : null;
}

/** @param {readonly string[]} steps @param {{mu:number,shape:number,hit:number,near:number,tau:number,mapTau:number}} [params] */
export function createStepTracker(steps, params = TRACKER_PARAMS) {
  const n = steps.length;
  const {mu, shape, hit, near, tau} = params;
  let belief = steps.map((_, index) => index === 0 ? 1 : 0);
  let announced = -1;
  let entered = 0;
  let lastT = 0;
  /** @type {number|null} */
  let sentenceStep = null;

  /** @param {number|null} observed @param {number} s */
  function likelihood(observed, s) {
    if (observed === null) return 1;
    const distance = Math.abs(observed - s);
    if (distance === 0) return hit;
    if (distance === 1) return near;
    return Math.max(1e-3, 1 - hit - 2 * near) / Math.max(1, n - 3);
  }

  /** @param {number} t @param {number|null} observed */
  function observeStep(t, observed) {
    const dt = Math.max(0.1, t - lastT);
    lastT = t;
    const dwell = Math.max(0.1, t - entered);
    const hazard = (shape / mu) * Math.pow(dwell / mu, shape - 1);
    const advance = 1 - Math.exp(-hazard * dt);
    const next = new Array(n).fill(0);
    belief.forEach((b, s) => {
      if (s + 1 < n) {
        next[s] += b * (1 - advance);
        next[s + 1] += b * advance * 0.9;
        if (s + 2 < n) next[s + 2] += b * advance * 0.1;
        else next[s + 1] += b * advance * 0.1;
      } else {
        next[s] += b;
      }
    });
    const weighted = next.map((b, s) => b * likelihood(observed, s));
    const total = weighted.reduce((sum, b) => sum + b, 0) || 1;
    belief = weighted.map(b => b / total);
    let best = 0;
    belief.forEach((b, s) => { if (b > belief[best]) best = s; });
    const from = announced;
    const moved = best > announced && belief[best] >= tau;
    if (moved) {
      announced = best;
      entered = t;
    }
    return {moved, from, step:best, current:announced, belief:belief[best], mapped:observed};
  }

  return {
    observeStep,
    /** Decides from the words known so far, never from words not yet produced.
     * Each step a sentence comes to name is one observation.
     * @param {number} t @param {string} known
     */
    observeKnown(t, known) {
      const observed = closestStep(known, steps, params.mapTau);
      if (observed === null || observed === sentenceStep) return null;
      sentenceStep = observed;
      return observeStep(t, observed);
    },
    /** A sentence that never named a step still lets time pass.
     * @param {number} t
     */
    endSentence(t) {
      const named = sentenceStep;
      sentenceStep = null;
      return named === null ? observeStep(t, null) : null;
    },
    current: () => announced,
    beliefs: () => [...belief],
  };
}

/** Same arithmetic as the offline tracker, for parity checks against saved runs.
 * @param {ReadonlyArray<readonly [number, number, number|null]>} rows @param {readonly string[]} steps
 * @param {{mu:number,shape:number,hit:number,near:number,tau:number,mapTau:number}} [params]
 */
export function filterVideo(rows, steps, params = TRACKER_PARAMS) {
  const tracker = createStepTracker(steps, params);
  const kept = [];
  for (const [t, latency, observed] of rows) {
    const result = tracker.observeStep(t, observed);
    if (result.moved) kept.push({time:Math.round((t + latency) * 1000) / 1000, step:result.current});
  }
  return kept;
}

const SENTENCE_END = /[.!?]+(?=\s|$)/;

/** Streaming sentence split matching the offline predictions builder.
 * `stamp` is opaque: each sentence keeps the stamp of its first text.
 * @template T
 */
export function createSentenceSplitter() {
  let buffer = "";
  /** @type {T|null} */
  let start = null;

  /** @param {string} text @returns {string|null} */
  function clean(text) {
    const value = text.split(/\s+/u).filter(Boolean).join(" ");
    return /[\p{L}\p{N}]/u.test(value) ? value : null;
  }

  return {
    /** @param {string} text @param {T} stamp @returns {{value:string,stamp:T}[]} */
    push(text, stamp) {
      const out = [];
      if (text.trim() && start === null) start = stamp;
      buffer += text;
      for (;;) {
        const match = SENTENCE_END.exec(buffer);
        if (!match) break;
        const end = match.index + match[0].length;
        const value = clean(buffer.slice(0, end));
        if (value) out.push({value, stamp:start ?? stamp});
        buffer = buffer.slice(end).trimStart();
        start = buffer.trim() ? stamp : null;
      }
      return out;
    },
    /** @param {T} stamp @returns {{value:string,stamp:T}[]} */
    flush(stamp) {
      const value = buffer.trim() ? clean(buffer) : null;
      const out = value ? [{value, stamp:start ?? stamp}] : [];
      buffer = "";
      start = null;
      return out;
    },
    pending: () => buffer.trim().length > 0,
    /** The unfinished sentence, leaving the splitter unchanged.
     * @returns {{value:string,stamp:T}[]}
     */
    peek() {
      const value = buffer.trim() ? clean(buffer) : null;
      return value && start !== null ? [{value, stamp:start}] : [];
    },
  };
}

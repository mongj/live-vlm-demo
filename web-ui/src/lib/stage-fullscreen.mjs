/** @typedef {{mode: 'inline' | 'fullscreen' | 'expanded', notice: string | null}} StageFullscreenState */

/**
 * Switching responsive trees replaces the video and its local caption state.
 * Keep the original tree until doing so cannot disrupt active media or a session.
 * @param {boolean | null} lockedLayout
 * @param {{viewportIsDesktop: boolean, videoSource: string, sessionActive: boolean, fullscreenActive: boolean}} activity
 * @returns {boolean | null}
 */
export function releaseStageLayout(lockedLayout, activity) {
  if (activity.fullscreenActive) return lockedLayout;
  if (lockedLayout === activity.viewportIsDesktop ||
      (activity.videoSource === "none" && !activity.sessionActive)) return null;
  return lockedLayout;
}

/**
 * Request fullscreen on the whole video stage, so guidance and controls follow.
 * Browser events, not button clicks, are authoritative for native fullscreen.
 * @param {{element: HTMLElement, document: Document, onChange: (state: StageFullscreenState) => void, onLayoutLock?: (locked: boolean) => void}} options
 */
export function createStageFullscreen({ element, document, onChange, onLayoutLock }) {
  /** @type {StageFullscreenState} */
  let state = { mode: "inline", notice: null };
  let disposed = false;
  let entering = false;
  /** @param {StageFullscreenState} next */
  function publish(next) {
    if (disposed) return;
    state = next;
    onLayoutLock?.(next.mode !== "inline");
    onChange(next);
  }
  function sync() {
    if (document.fullscreenElement === element) {
      publish({ mode: "fullscreen", notice: null });
    } else if (state.mode === "fullscreen") {
      publish({ mode: "inline", notice: null });
    }
  }
  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (event.key === "Escape" && !event.defaultPrevented && state.mode === "expanded") {
      publish({ mode: "inline", notice: null });
    }
  }
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("keydown", onKeyDown);
  return {
    async enter() {
      if (disposed || entering) return;
      entering = true;
      // The native request can resize before fullscreenchange; pin the layout
      // now so a responsive branch switch cannot remove this very element.
      onLayoutLock?.(true);
      try {
        if (document.fullscreenEnabled === false || typeof element.requestFullscreen !== "function") {
          throw new Error("Fullscreen unavailable");
        }
        await element.requestFullscreen();
        if (document.fullscreenElement !== element) throw new Error("Fullscreen not entered");
        sync();
      } catch {
        if (document.fullscreenElement === element) sync();
        else publish({ mode: "expanded", notice: "Fullscreen unavailable; using expanded view. Press Escape to close." });
      } finally {
        entering = false;
      }
    },
    async exit() {
      if (disposed) return;
      if (document.fullscreenElement === element) {
        try {
          await document.exitFullscreen();
          sync();
        } catch {
          publish(document.fullscreenElement === element
            ? { mode: "fullscreen", notice: "Could not exit fullscreen. Press Escape to exit." }
            : { mode: "inline", notice: null });
        }
      } else {
        publish({ mode: "inline", notice: null });
      }
    },
    dispose() {
      disposed = true;
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", onKeyDown);
    },
  };
}

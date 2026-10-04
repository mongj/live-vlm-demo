/** @typedef {{text: string, modelId: string, streaming: boolean, suppressed?: boolean}} GuidanceState */

/** The video stage must retain failure status after session cleanup.
 * @param {boolean} sessionLive @param {string | null} fatalError
 */
export function videoSessionView(sessionLive, fatalError) {
  return fatalError
    ? { label: "Session ended", error: fatalError }
    : { label: sessionLive ? "Live" : "Ready", error: null };
}

/**
 * Only presentable assistant text belongs in the video guidance. Raw metadata,
 * input transcription and audio playback state deliberately stay separate.
 * @param {GuidanceState | null} current
 * @param {{text?: string, final?: boolean, modelId?: string, interrupted?: boolean, reset?: boolean, failed?: boolean, turnOpen?: boolean}} chunk
 * @returns {GuidanceState | null}
 */
export function updateGuidance(current, chunk) {
  if (chunk.reset) return null;
  if (chunk.failed) {
    if (chunk.turnOpen || current?.streaming || current?.suppressed) {
      return { text: "", modelId: current?.modelId ?? "", streaming: false, suppressed: true };
    }
    return null;
  }
  if (chunk.interrupted || current?.suppressed) {
    return { text: "", modelId: chunk.modelId ?? current?.modelId ?? "", streaming: false, suppressed: !chunk.final };
  }
  const text = chunk.text ?? "";
  if (!text.trim()) {
    if (current?.streaming && text.length) {
      return { ...current, text: current.text + text, streaming: !chunk.final };
    }
    return current && chunk.final ? { ...current, streaming: false } : current;
  }
  return {
    text: current?.streaming ? current.text + text : text,
    modelId: chunk.modelId ?? current?.modelId ?? "",
    streaming: !chunk.final,
  };
}

/** @param {GuidanceState | null} state @param {boolean} sessionLive @param {string} cameraView */
export function guidanceView(state, sessionLive, cameraView) {
  if (!sessionLive || cameraView !== "live" || !state?.text.trim()) return null;
  return {
    text: state.text,
    label: "Assistant response",
    streaming: state.streaming,
  };
}

/**
 * Small captions stay fixed at bottom centre, above the library's transport.
 * @param {boolean} fileActive
 * @returns {import('react').CSSProperties}
 */
export function guidanceBoxStyle(fileActive) {
  return {
    width: "max-content",
    maxWidth: "min(18rem, 75%)",
    minWidth: "min(8rem, 75%)",
    bottom: fileActive ? "4rem" : "1rem",
    left: "50%",
    transform: "translateX(-50%)",
  };
}

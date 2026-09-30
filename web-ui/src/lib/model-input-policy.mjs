/**
 * @param {string | undefined} modelId
 * @param {boolean} sessionLive
 * @returns {{enabled: boolean, notice: string | null}}
 */
export function typedInputPolicy(modelId, sessionLive) {
  if (modelId === "minicpm-o-4-5") {
    return {
      enabled: false,
      notice: "MiniCPM live video does not support typed follow-ups. Set instructions before starting. Sessions end after five minutes; start a new session to continue.",
    };
  }
  return { enabled: sessionLive, notice: null };
}

/**
 * The cluster and Modal deployments run the same JoyAI webinfer.
 * @param {string | undefined} modelId
 * @returns {boolean}
 */
export function isJoyAIModel(modelId) {
  return modelId === "joyai-vl" || modelId === "joyai-vl-modal";
}

/**
 * @param {string | undefined} modelId
 * @param {boolean} sessionLive
 * @param {{typed_input?:boolean}|null} [speech]
 * @param {boolean} [busy]
 * @returns {{enabled: boolean, notice: string | null}}
 */
export function typedInputPolicy(modelId, sessionLive, speech = null, busy = false) {
  if (modelId === "minicpm-o-4-5") {
    return {
      enabled: sessionLive && speech?.typed_input === true && !busy,
      notice: !sessionLive ? null : speech?.typed_input ? null : "Typed input unavailable: the self-hosted speech helper is not ready. Live microphone input is unchanged.",
    };
  }
  return { enabled: sessionLive && !((isJoyAIModel(modelId) || modelId === 'mock' || modelId === 'wizard-of-oz') && speech?.typed_input && busy), notice: null };
}

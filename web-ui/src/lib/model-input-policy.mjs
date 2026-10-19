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
  return { enabled: sessionLive && !(modelId === 'joyai-vl' && speech?.typed_input && busy), notice: null };
}

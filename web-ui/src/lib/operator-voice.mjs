/** Wizard of Oz replies read aloud by the browser, under the same mute and volume as model audio.
 * A volume change applies from the next reply, because browsers fix it when speech starts.
 * @param {() => {speak:(utterance:any)=>void,cancel:()=>void,speaking:boolean}|undefined} [getSynth]
 * @param {(new (text:string) => {volume:number})|undefined} [Utterance]
 */
export function createOperatorVoice(getSynth = () => globalThis.speechSynthesis, Utterance = undefined) {
  let enabled = true;
  let muted = false;
  let volume = 1;
  const stop = () => getSynth()?.cancel();

  return {
    stop,
    speaking: () => Boolean(getSynth()?.speaking),
    /** Latest guidance wins: an older reply stops rather than queueing.
     * @param {string} text
     */
    speak(text) {
      stop();
      const synth = getSynth();
      const Speech = Utterance ?? globalThis.SpeechSynthesisUtterance;
      if (!enabled || muted || volume === 0 || !synth || !Speech) return;
      const utterance = new Speech(text);
      utterance.volume = volume;
      synth.speak(utterance);
    },
    /** @param {boolean} next */
    setEnabled(next) {
      enabled = next;
      if (!next) stop();
    },
    /** Silencing stops speech already playing. Unmuting never replays it.
     * @param {{muted:boolean,volume:number}} output
     */
    setOutput(output) {
      muted = output.muted;
      volume = output.volume;
      if (muted || volume === 0) stop();
    },
  };
}

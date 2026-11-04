/** @typedef {{key:string,label:string,value:string,detail?:string,tone?:'ok'|'warn'|'bad',meter?:number}} DebugTile */

const UNIT_BUDGET_MS = 1000;
const NEAR_BUDGET_MS = 800;

/** @param {number|null|undefined} ms */
export function formatSeconds(ms) {
  return ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

/** Compact readings for Debug. Anything the runtime has not reported stays "Not reported".
 * @param {import('./runtime-diagnostics.mjs').RuntimeDiagnostic|undefined} latest
 * @param {{sentencesPerMinute:number,sentenceCount:number}|null|undefined} run
 * @returns {DebugTile[]}
 */
export function debugTiles(latest, run) {
  const units = latest?.units;
  const native = latest?.native;
  const compute = units?.last_compute_ms;
  const total = units ? units.speak + units.listen : 0;
  /** @type {DebugTile[]} */
  const tiles = [];
  tiles.push(compute === undefined
    ? {key:"compute", label:"Last unit compute", value:"Not reported", detail:"1 s budget"}
    : {key:"compute", label:"Last unit compute", value:`${Math.round(compute)} ms`,
      detail:compute > UNIT_BUDGET_MS ? "Over the 1 s budget" : `${Math.round(compute / UNIT_BUDGET_MS * 100)}% of the 1 s budget`,
      tone:compute > UNIT_BUDGET_MS ? "bad" : compute > NEAR_BUDGET_MS ? "warn" : "ok",
      meter:Math.min(1, compute / UNIT_BUDGET_MS)});
  tiles.push(!units
    ? {key:"overruns", label:"Overruns", value:"Not reported"}
    : {key:"overruns", label:"Overruns", value:`${units.overruns}`,
      detail:`of ${total} units${units.max_compute_ms !== undefined ? ` · worst ${Math.round(units.max_compute_ms)} ms` : ""}`,
      tone:units.overruns > 0 ? "warn" : "ok"});
  tiles.push(!units || total === 0
    ? {key:"speaking", label:"Speaking share", value:"Not reported"}
    : {key:"speaking", label:"Speaking share", value:`${Math.round(units.speak / total * 100)}%`, detail:`${units.speak} of ${total} units`});
  tiles.push(!run
    ? {key:"sentences", label:"Sentences per minute", value:"No replies yet"}
    : {key:"sentences", label:"Sentences per minute", value:run.sentencesPerMinute.toFixed(1), detail:`${run.sentenceCount} ${run.sentenceCount === 1 ? "sentence" : "sentences"}`});
  tiles.push(!native
    ? {key:"streak", label:"Listen streak", value:"Not reported"}
    : {key:"streak", label:"Listen streak", value:`${native.listen_streak}`, detail:native.listen_streak === 1 ? "unit in a row" : "units in a row"});
  tiles.push(native?.matched && native.input_age_ms !== undefined
    ? {key:"age", label:"Input age", value:formatSeconds(native.input_age_ms), detail:"Packet sent to output received",
      tone:native.input_age_ms > 3000 ? "bad" : native.input_age_ms > 1500 ? "warn" : "ok"}
    : {key:"age", label:"Input age", value:"Not reported", detail:"Packet sent to output received"});
  return tiles;
}

/** @type {Record<string,string>} */
export const TURN_KIND_LABELS = {request:"Request", check_in:"Check-in", typed:"Typed", voice:"Voice", proactive:"Unprompted"};

/** @type {Record<string,string>} */
export const CHECK_IN_SKIP_LABELS = {
  typed_unavailable:"typed speech unavailable", video_paused:"video paused", user_speaking:"you were speaking",
  input_busy:"another input was being sent", model_replying:"model was replying", late:"its time had passed",
};

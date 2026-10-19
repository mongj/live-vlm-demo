/** Content-free snapshots, kept separate from model text and transcript turns.
 * @typedef {{version:1,event:string,elapsed_ms:number,stage:string,
 * input:{packets:number,frames:number,audio_ms:number,dropped_audio_ms:number},
 * output:{text_chunks:number,audio_chunks:number,audio_ms:number},
 * speech:{transcription:boolean,typed_input:boolean,asr_ms?:number,tts_ms?:number},
 * metrics?:Record<string,number>,chunk_index?:number}} RuntimeDiagnostic
 * @typedef {{receivedAt:number,snapshot:RuntimeDiagnostic}} RuntimeDiagnosticEntry
 */

const EVENTS = new Set(['startup','admission','session_ready','input_sent','model_output',
  'input_drop','asr_complete','asr_failed','tts_complete','tts_failed','error','closed']);
const STAGES = new Set(['connecting','queued','connected','listening','responding','error','closed']);
const METRICS = ['prefill_ms','generate_ms','wall_clock_ms','cost_llm_ms','kv_cache_length',
  'n_tokens','n_tts_tokens','vision_slices','vision_tokens'];

/** @param {unknown} v @returns {v is Record<string,unknown>} */
function record(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
/** @param {unknown} v @returns {v is number} */
function number(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER; }
/** @param {unknown} v @returns {v is number} */
function count(v) { return number(v) && Number.isSafeInteger(v); }

/** Whitelist before display OR console output; never forward arbitrary wire fields.
 * @param {unknown} value @returns {RuntimeDiagnostic|null}
 */
export function parseRuntimeDiagnostic(value) {
  if (!record(value) || value.version !== 1 || typeof value.event !== 'string' || !EVENTS.has(value.event)
    || typeof value.stage !== 'string' || !STAGES.has(value.stage) || !number(value.elapsed_ms)) return null;
  const {input, output, speech} = value;
  if (!record(input) || !record(output) || !record(speech)
    || !count(input.packets) || !count(input.frames) || !number(input.audio_ms) || !number(input.dropped_audio_ms)
    || !count(output.text_chunks) || !count(output.audio_chunks) || !number(output.audio_ms)
    || typeof speech.transcription !== 'boolean' || typeof speech.typed_input !== 'boolean') return null;
  /** @type {RuntimeDiagnostic} */
  const result = {version:1,event:value.event,elapsed_ms:value.elapsed_ms,stage:value.stage,
    input:{packets:input.packets,frames:input.frames,audio_ms:input.audio_ms,dropped_audio_ms:input.dropped_audio_ms},
    output:{text_chunks:output.text_chunks,audio_chunks:output.audio_chunks,audio_ms:output.audio_ms},
    speech:{transcription:speech.transcription,typed_input:speech.typed_input}};
  if (number(speech.asr_ms)) result.speech.asr_ms = speech.asr_ms;
  if (number(speech.tts_ms)) result.speech.tts_ms = speech.tts_ms;
  if (count(value.chunk_index)) result.chunk_index = value.chunk_index;
  if (record(value.metrics)) {
    const metrics = Object.fromEntries(METRICS.flatMap(key => number(value.metrics[key]) ? [[key,value.metrics[key]]] : []));
    if (Object.keys(metrics).length) result.metrics = metrics;
  }
  return result;
}

/** @param {RuntimeDiagnosticEntry[]} entries @param {RuntimeDiagnostic} snapshot
 * @param {number} receivedAt @returns {RuntimeDiagnosticEntry[]}
 */
export function appendRuntimeDiagnostic(entries, snapshot, receivedAt) {
  const last = entries.at(-1)?.snapshot;
  if (last && (snapshot.elapsed_ms < last.elapsed_ms || JSON.stringify(snapshot) === JSON.stringify(last))) return entries;
  return [...entries.slice(-119), {receivedAt,snapshot}];
}

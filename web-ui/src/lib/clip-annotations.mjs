/** @typedef {{question:string,askS:number|null,responseTimes:number[],responses:string[]}} AnnotationTurn */
/** @typedef {{kind:string,label:string,task:string,steps:string[],actions:string[],turns:AnnotationTurn[]}} ClipAnnotation */

const KIND_LABELS = {
  abd:"Action boundary detection", pnr:"Point of no return", sqa:"Streaming question answering",
  spg:"Streaming procedural guidance", si:"Solicited intervention", ui:"Unsolicited intervention",
};

/** @param {unknown} value @returns {value is Record<string,unknown>} */
const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value @returns {string} */
const text = value => typeof value === "string" ? value.trim() : "";
/** @param {unknown} value @returns {string[]} */
const texts = value => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
/** @param {unknown} value @returns {number|null} */
const number = value => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Reads the gateway's annotation response. UI clips keep the question and ask time beside their turns.
 * @param {unknown} body @returns {ClipAnnotation|null}
 */
export function parseClipAnnotation(body) {
  if (!isRecord(body) || !isRecord(body.annotation) || typeof body.kind !== "string") return null;
  const entry = body.annotation;
  const turns = (Array.isArray(entry.turns) ? entry.turns : []).filter(isRecord).map(turn => ({
    question:text(turn.question ?? entry.question),
    askS:number(turn.ask_time ?? entry.ask_time),
    responseTimes:(Array.isArray(turn.response_time) ? turn.response_time : []).map(number).filter(time => time !== null),
    responses:texts(turn.response),
  }));
  const spg = body.kind === "spg";
  return {
    kind:body.kind,
    label:KIND_LABELS[/** @type {keyof typeof KIND_LABELS} */ (body.kind)] ?? body.kind,
    task:text(entry.task ?? entry.scenario),
    steps:spg ? turns.flatMap(turn => turn.responses) : [],
    actions:texts(entry.actions),
    turns,
  };
}

/** Only SPG clips have an ordered list for procedure mode. Reference times stay out of it, so they never reach the prompt.
 * @param {ClipAnnotation} annotation @returns {{task:string,stepsText:string}|null}
 */
export function annotationProcedure(annotation) {
  if (!annotation.task || !annotation.steps.length) return null;
  return {task:annotation.task, stepsText:annotation.steps.join("\n")};
}

/** @param {string} sourceId @param {string} name */
export function annotationsUrl(sourceId, name) {
  return `/v1/videos/${encodeURIComponent(name)}/annotations?${new URLSearchParams({key:sourceId})}`;
}

/** @param {string} sourceId @param {string} name @param {AbortSignal} [signal] @returns {Promise<ClipAnnotation|null>} */
export async function fetchClipAnnotation(sourceId, name, signal) {
  const response = await fetch(annotationsUrl(sourceId, name), {cache:"no-store", signal});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Annotations could not be read (${response.status})`);
  return parseClipAnnotation(await response.json());
}

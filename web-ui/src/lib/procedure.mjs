/** @typedef {{enabled:boolean,task:string,stepsText:string,instruction:string,checkIns:boolean,checkInInterval:number,checkInText:string,tracker:boolean,showOnlyNewSteps:boolean,speakOnlyNewSteps:boolean}} ProcedureConfig */

export const DEFAULT_STANDING_INSTRUCTION = "Keep watching me. Every time what I am doing changes, quickly tell me what I am doing and the next step. Do not wait to be asked.";
export const DEFAULT_CHECK_IN_TEXT = "What is the next step? Give one short instruction.";
export const DEFAULT_CHECK_IN_INTERVAL = 15;
export const MIN_CHECK_IN_INTERVAL = 5;
export const MAX_CHECK_IN_INTERVAL = 300;
const MAX_TASK_CHARS = 200;
const MAX_STEPS = 64;
const MAX_STEP_CHARS = 300;
const MAX_TYPED_CHARS = 500;

/** @returns {ProcedureConfig} */
export function defaultProcedure() {
  return {enabled:false, task:"", stepsText:"", instruction:DEFAULT_STANDING_INSTRUCTION,
    checkIns:false, checkInInterval:DEFAULT_CHECK_IN_INTERVAL, checkInText:DEFAULT_CHECK_IN_TEXT,
    tracker:true, showOnlyNewSteps:false, speakOnlyNewSteps:false};
}

/** One step per line; pasted numbering and bullets are not part of the step.
 * @param {string} text @returns {string[]}
 */
export function parseSteps(text) {
  return text.split(/\r?\n/u).map(line => line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/u, "").trim()).filter(Boolean);
}

/** Wording matches the replay experiments, so app sessions stay comparable.
 * @param {{task:string,steps:readonly string[],silentVideo?:boolean}} input @returns {string}
 */
export function buildProcedurePrompt({task, steps, silentVideo = false}) {
  const opening = silentVideo ? "Watch this silent task video as it unfolds." : "Watch this task as it unfolds.";
  const listed = steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `${opening} Give brief, relevant next-step guidance when visible progress makes it useful. `
    + "Ground guidance only in frames already observed; do not invent progress or claim unseen steps are complete."
    + `\nTask: ${task.trim()}\nKnown ordered actions:\n${listed}`;
}

/** @param {ProcedureConfig} procedure @returns {Record<string,string>} */
export function procedureErrors(procedure) {
  if (!procedure.enabled) return {};
  /** @type {Record<string,string>} */
  const errors = {};
  const steps = parseSteps(procedure.stepsText);
  if (!procedure.task.trim()) errors.task = "Enter a task name.";
  else if (procedure.task.length > MAX_TASK_CHARS) errors.task = `Use at most ${MAX_TASK_CHARS} characters.`;
  if (!steps.length) errors.steps = "Enter at least one step, one per line.";
  else if (steps.length > MAX_STEPS) errors.steps = `Use at most ${MAX_STEPS} steps.`;
  else if (steps.some(step => step.length > MAX_STEP_CHARS)) errors.steps = `Keep each step under ${MAX_STEP_CHARS} characters.`;
  const instruction = procedure.instruction.trim();
  if (!instruction) errors.instruction = "Enter the instruction to deliver before playback.";
  else if (instruction.length > MAX_TYPED_CHARS) errors.instruction = `Use at most ${MAX_TYPED_CHARS} characters.`;
  if (procedure.checkIns) {
    const interval = procedure.checkInInterval;
    if (!Number.isFinite(interval) || interval < MIN_CHECK_IN_INTERVAL || interval > MAX_CHECK_IN_INTERVAL) {
      errors.checkInInterval = `Enter ${MIN_CHECK_IN_INTERVAL} to ${MAX_CHECK_IN_INTERVAL} seconds.`;
    }
    const text = procedure.checkInText.trim();
    if (!text) errors.checkInText = "Enter the check-in text.";
    else if (text.length > MAX_TYPED_CHARS) errors.checkInText = `Use at most ${MAX_TYPED_CHARS} characters.`;
  }
  return errors;
}

/** Only fields this adapter advertises are sent; Config rejects unknown keys.
 * @param {Record<string,unknown>|undefined} schemaProperties @param {Record<string,unknown>} config
 * @param {ProcedureConfig} procedure @param {{silentVideo?:boolean}} [options]
 */
export function procedureSessionConfig(schemaProperties, config, procedure, options = {}) {
  const properties = schemaProperties ?? {};
  const prompt = buildProcedurePrompt({task:procedure.task, steps:parseSteps(procedure.stepsText), silentVideo:options.silentVideo});
  const promptSupported = "system_prompt" in properties;
  const policySupported = "response_policy" in properties;
  return {
    config:{...config, ...(promptSupported ? {system_prompt:prompt} : {}), ...(policySupported ? {response_policy:"none"} : {})},
    prompt, promptSupported, policySupported,
  };
}

/** Stored preferences are untrusted: anything invalid falls back to its default.
 * @param {unknown} value @returns {ProcedureConfig}
 */
export function sanitizeProcedure(value) {
  const base = defaultProcedure();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return base;
  const raw = /** @type {Record<string,unknown>} */ (value);
  /** @param {string} fallback @param {unknown} v @param {number} limit */
  const text = (fallback, v, limit) => typeof v === "string" && v.length <= limit ? v : fallback;
  /** @param {boolean} fallback @param {unknown} v */
  const flag = (fallback, v) => typeof v === "boolean" ? v : fallback;
  return {
    enabled:flag(base.enabled, raw.enabled),
    task:text(base.task, raw.task, 1000),
    stepsText:text(base.stepsText, raw.stepsText, 32_000),
    instruction:text(base.instruction, raw.instruction, 2000),
    checkIns:flag(base.checkIns, raw.checkIns),
    checkInInterval:typeof raw.checkInInterval === "number" && Number.isFinite(raw.checkInInterval) ? raw.checkInInterval : base.checkInInterval,
    checkInText:text(base.checkInText, raw.checkInText, 2000),
    tracker:flag(base.tracker, raw.tracker),
    showOnlyNewSteps:flag(base.showOnlyNewSteps, raw.showOnlyNewSteps),
    speakOnlyNewSteps:flag(base.speakOnlyNewSteps, raw.speakOnlyNewSteps),
  };
}

const STORAGE_KEY = "vlm-playground:procedure:v1";

/** @returns {ProcedureConfig} */
export function readStoredProcedure() {
  try {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored !== null) return sanitizeProcedure(JSON.parse(stored));
    }
  } catch {
    // Corrupt, blocked or unavailable storage must not prevent using the app.
  }
  return defaultProcedure();
}

/** @param {ProcedureConfig} procedure */
export function writeStoredProcedure(procedure) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, JSON.stringify(procedure));
  } catch {
    // Remembering the form is best effort.
  }
}

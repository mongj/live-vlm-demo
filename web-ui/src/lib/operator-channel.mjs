/** Links the app window to a separate operator window in the same browser, so a
 * participant watching the app window never sees the operator box. Same origin only.
 */

export const OPERATOR_CHANNEL = "live-vlm-operator";
/** No beat for this long means the operator window has gone. */
export const OPERATOR_STALE_MS = 3000;
/** The gateway's limit on one operator reply. */
export const OPERATOR_MAX_CHARS = 2000;
const MAX_FRAME_CHARS = 400_000;
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 2000;

/** @typedef {{postMessage:(message:unknown)=>void,onmessage:any}} ChannelLike */
/** @typedef {{live:boolean,task:string,steps:string[],currentStep:number,clipS:number|null,voice:boolean,messages:{role:string,text:string}[]}} HostState */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** The channel is same-origin but another tab can write to it, so rebuild what is shown.
 * @param {unknown} value @returns {HostState}
 */
export function cleanHostState(value) {
  const state = record(value) ? value : {};
  return {
    live:state.live === true,
    task:typeof state.task === "string" ? state.task.slice(0, 1000) : "",
    steps:Array.isArray(state.steps) ? state.steps.filter(step => typeof step === "string").slice(0, 64).map(step => step.slice(0, 1000)) : [],
    currentStep:Number.isInteger(state.currentStep) ? /** @type {number} */ (state.currentStep) : -1,
    clipS:typeof state.clipS === "number" && Number.isFinite(state.clipS) ? state.clipS : null,
    voice:state.voice === true,
    messages:Array.isArray(state.messages) ? state.messages.filter(record).slice(-MAX_MESSAGES).flatMap(row =>
      typeof row.role === "string" && typeof row.text === "string" ? [{role:row.role.slice(0, 16), text:row.text.slice(0, MAX_MESSAGE_CHARS)}] : []) : [],
  };
}

/** App window side. Refusals come from `onSend`, which only accepts a live Wizard of Oz session.
 * @param {{channel:ChannelLike,hostId:string,now:()=>number,onSend:(text:string)=>boolean,onVoice:(enabled:boolean)=>void}} options
 */
export function createOperatorHost({channel, hostId, now, onSend, onVoice}) {
  /** @type {number|null} */
  let seenAt = null;
  channel.onmessage = (/** @type {{data:unknown}} */ {data}) => {
    if (!record(data)) return;
    // A beat names the one app window the operator window replies to. Others keep their own box.
    if (data.kind === "operator-beat") {
      if (data.hostId === hostId) seenAt = now();
    } else if (data.kind === "operator-bye") {
      if (data.hostId === hostId) seenAt = null;
    } else if (data.hostId === hostId && data.kind === "operator-send" && typeof data.id === "string" && typeof data.text === "string") {
      const ok = data.text.length <= OPERATOR_MAX_CHARS && onSend(data.text) === true;
      channel.postMessage({kind:"host-result", hostId, id:data.id, ok});
    } else if (data.hostId === hostId && data.kind === "operator-voice" && typeof data.enabled === "boolean") {
      onVoice(data.enabled);
    }
  };
  return {
    connected: () => seenAt !== null && now() - seenAt < OPERATOR_STALE_MS,
    /** @param {HostState} state */
    publish(state) { channel.postMessage({kind:"host-state", hostId, state}); },
    /** @param {string} frame */
    publishFrame(frame) { if (frame.length <= MAX_FRAME_CHARS) channel.postMessage({kind:"host-frame", hostId, frame}); },
    close() {
      channel.postMessage({kind:"host-bye", hostId});
      channel.onmessage = null;
    },
  };
}

/** Operator window side. A live session wins over an idle app window, and an open
 * link is kept if a second live session appears, so replies never go to both.
 * @param {{channel:ChannelLike,now:()=>number,onChange:()=>void,onResult:(result:{id:string,ok:boolean,text:string})=>void}} options
 */
export function createOperatorClient({channel, now, onChange, onResult}) {
  /** @type {{id:string,state:HostState,seenAt:number}|null} */
  let host = null;
  /** @type {string|null} */
  let frame = null;
  let counter = 0;
  /** @type {Map<string,string>} */
  const sent = new Map();
  const fresh = () => host !== null && now() - host.seenAt < OPERATOR_STALE_MS;

  channel.onmessage = (/** @type {{data:unknown}} */ {data}) => {
    if (!record(data) || typeof data.hostId !== "string") return;
    if (data.kind === "host-state") {
      const state = cleanHostState(data.state);
      const current = fresh() ? host : null;
      if (current && current.id !== data.hostId && !(state.live && !current.state.live)) return;
      // A frame from before a gap, or from another window, is not what is happening now.
      if (!current || current.id !== data.hostId) frame = null;
      const newLink = !current || current.id !== data.hostId;
      host = {id:data.hostId, state, seenAt:now()};
      if (newLink) channel.postMessage({kind:"operator-beat", hostId:data.hostId});
      onChange();
    } else if (data.hostId !== host?.id) {
      return;
    } else if (data.kind === "host-frame" && typeof data.frame === "string") {
      frame = data.frame;
      onChange();
    } else if (data.kind === "host-bye") {
      host = null;
      frame = null;
      onChange();
    } else if (data.kind === "host-result" && typeof data.id === "string") {
      const text = sent.get(data.id);
      if (text === undefined) return;
      sent.delete(data.id);
      onResult({id:data.id, ok:data.ok === true, text});
    }
  };

  return {
    /** Sent about once a second. Also notices an app window that went away without saying so. */
    beat() {
      if (host && !fresh()) {
        host = null;
        frame = null;
        onChange();
      }
      channel.postMessage({kind:"operator-beat", hostId:host?.id ?? null});
    },
    /** @param {string} text @returns {boolean} false when nothing could take the reply */
    send(text) {
      if (!host || !fresh() || !host.state.live) return false;
      const id = `${now()}-${++counter}`;
      sent.set(id, text);
      channel.postMessage({kind:"operator-send", hostId:host.id, id, text});
      return true;
    },
    /** @param {boolean} enabled */
    setVoice(enabled) {
      if (host) channel.postMessage({kind:"operator-voice", hostId:host.id, enabled});
    },
    view: () => ({state:host && fresh() ? host.state : null, frame:host && fresh() ? frame : null}),
    close() {
      channel.postMessage({kind:"operator-bye", hostId:host?.id ?? null});
      channel.onmessage = null;
    },
  };
}

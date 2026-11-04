import { createSentenceSplitter, createStepTracker, TRACKER_PARAMS } from "./step-tracker.mjs";

/** @typedef {{task:string,steps:string[],instruction:string,prompt:string,responsePolicy:string,checkIns:{enabled:boolean,intervalS:number,text:string},tracker:boolean,showOnlyNewSteps:boolean,speakOnlyNewSteps:boolean}} RunProcedure */
/** @typedef {'request'|'check_in'|'typed'|'voice'|'proactive'} TurnKind */
/** @typedef {{index:number,kind:TurnKind,inputId?:string,queuedAtMs?:number,sendingAtMs?:number,sentAtMs?:number,firstTextAtMs?:number,firstAudioAtMs?:number,endAtMs?:number,replyChars:number,sentences:number,computeMs?:number,inputAgeMs?:number,status:string}} TurnRow */
/** @typedef {{text:string,audio:string|null,unit:number|undefined}} GateItem */
/** @typedef {NonNullable<ReturnType<typeof cleanRunExport>>} RunExport */

const MAX_TURNS = 2000;
const MAX_SENTENCES = 4000;
const MAX_SENTENCE_CHARS = 1000;
const MAX_CHECK_INS = 2000;
const REPLY_WINDOW_MS = 30_000;
const MIN_RATE_WINDOW_S = 10;
/** Bounded so a check-in never stacks on the next one or lands long after its slot. */
const MAX_DEFER_FRACTION = 0.5;
const AUDIO_BYTES_PER_MS = 48;

/** @param {number|undefined} end @param {number|undefined} start */
function span(end, start) {
  return end !== undefined && start !== undefined ? Math.max(0, end - start) : null;
}

/** Latency fields derived from one turn's timestamps; null means not observed.
 * @param {TurnRow} row
 */
export function turnBreakdown(row) {
  return {
    index:row.index, kind:row.kind, status:row.status,
    prepareMs:span(row.sendingAtMs, row.queuedAtMs),
    deliveryMs:span(row.sentAtMs, row.queuedAtMs),
    firstTextMs:span(row.firstTextAtMs, row.sentAtMs),
    firstAudioMs:span(row.firstAudioAtMs, row.sentAtMs),
    replyMs:span(row.endAtMs, row.firstTextAtMs),
    replyChars:row.replyChars, sentences:row.sentences,
    computeMs:row.computeMs ?? null, inputAgeMs:row.inputAgeMs ?? null,
  };
}

/** @param {number} value */
const round3 = value => Math.round(value * 1000) / 1000;

/** The tracker's frozen settings, in the names used by session log events. */
export const TRACKER_SETTINGS = Object.freeze({trackerMu:TRACKER_PARAMS.mu, trackerShape:TRACKER_PARAMS.shape, trackerHit:TRACKER_PARAMS.hit,
  trackerNear:TRACKER_PARAMS.near, trackerTau:TRACKER_PARAMS.tau, trackerMapTau:TRACKER_PARAMS.mapTau});

/** Per-session state behind the debug panel, step display and exports.
 * Pure apart from its own fields: callers supply every clock reading.
 * @param {{procedure?:RunProcedure|null,videoId?:string|null,startedAtMs:number,wizard?:boolean}} input
 */
export function createSessionRun({procedure = null, videoId = null, startedAtMs, wizard = false}) {
  const tracker = procedure?.tracker && procedure.steps.length ? createStepTracker(procedure.steps) : null;
  const splitter = createSentenceSplitter();
  /** @type {{clipS:number|null,wallMs:number,value:string,announced:boolean,step:number|null,decidedClipS?:number|null}[]} */
  const sentences = [];
  /** @type {{from:number,to:number,clipS:number|null,decidedClipS:number|null,wallMs:number,belief:number,mapped:number|null}[]} */
  const transitions = [];
  /** queued, then sent or failed once delivery is known, or skipped without being attempted.
   * @type {{index:number,dueS:number,state:string,reason?:string,queuedClipS?:number,sentClipS?:number,wallMs:number,resultWallMs?:number}[]}
   */
  const checkIns = [];
  /** @type {TurnRow[]} */
  const turns = [];
  /** @type {TurnRow[]} */
  const openInputs = [];
  /** @type {TurnRow|null} */
  let openReply = null;
  /** @type {TurnRow[]} */
  let closedTurns = [];
  let turnCounter = 0;
  /** @type {number|null} */
  let earlyAudioAtMs = null;
  /** @type {{computeMs?:number,inputAgeMs?:number}} */
  let runtime = {};
  let showOnly = !!procedure?.showOnlyNewSteps;
  let speakOnly = !!procedure?.speakOnlyNewSteps;
  let gateOpen = false;
  let voicedStep = -1;
  /** The sentence still being written has named this step.
   * @type {{step:number,decidedClipS:number|null}|null}
   */
  let sentenceNamed = null;
  /** @type {GateItem[]} */
  let held = [];
  const withheld = {replies:0, chars:0, audioBytes:0, spokenBytes:0};
  let turnWithheld = false;
  let droppedSentences = 0;
  /** @type {number|null} */
  let playbackStartedAtMs = null;
  /** @type {string|null} */
  let requestId = null;
  /** @type {{stage:string,detail?:string,startedAtMs:number,endedAtMs?:number}|null} */
  let hold = null;
  let checkInIndex = 0;
  /** @type {number|null} */
  let nextDueS = null;
  /** @type {{index:number,dueS:number,reason:string|null}|null} */
  let pendingCheckIn = null;
  let voiceRow = /** @type {TurnRow|null} */ (null);

  /** @param {TurnKind} kind @param {Partial<TurnRow>} [fields] @returns {TurnRow} */
  function addTurn(kind, fields = {}) {
    const row = {index:++turnCounter, kind, replyChars:0, sentences:0, status:"open", ...fields};
    turns.push(row);
    if (turns.length > MAX_TURNS) turns.shift();
    return row;
  }

  /** @param {TurnRow} row @param {string} status @param {number} [atMs] */
  function closeTurn(row, status, atMs) {
    row.status = status;
    if (atMs !== undefined) row.endAtMs = atMs;
    closedTurns.push(row);
  }

  /** @param {number} wallMs @returns {TurnRow} */
  function replyRow(wallMs) {
    if (openReply) return openReply;
    for (;;) {
      const candidate = openInputs.findLast(row => row.sentAtMs !== undefined);
      if (!candidate) break;
      // Older delivered inputs got no reply of their own.
      for (const older of openInputs.splice(0, openInputs.indexOf(candidate))) closeTurn(older, "no_reply");
      openInputs.shift();
      if (wallMs - /** @type {number} */ (candidate.sentAtMs) <= REPLY_WINDOW_MS) {
        openReply = candidate;
        return candidate;
      }
      closeTurn(candidate, "no_reply");
    }
    openReply = addTurn("proactive");
    return openReply;
  }

  /** A filter is holding this reply back, so cutting it now means nobody got it. */
  function replyWithheld() {
    return (showOnly || speakOnly) && !!tracker && !gateOpen;
  }

  /** A sentence goes through when the tracker reaches a step not yet delivered, the
   * same moment the offline tracker speaks. That can be on elapsed time alone (mapped
   * null), so filler can go through. Words cut off while withheld still inform the
   * tracker, but their step stays undelivered, so the next observation delivers it.
   * @param {ReturnType<ReturnType<typeof createStepTracker>["observeStep"]>|null} result
   * @param {{clipS:number|null}} start @param {{clipS:number|null,wallMs:number}} at
   * @param {boolean} delivered @param {{moved:object[],announcedStep:number|null}} sink
   */
  function applyDecision(result, start, at, delivered, sink) {
    if (!result) return;
    if (result.moved) {
      const transition = {from:result.from, to:result.current, clipS:start.clipS, decidedClipS:at.clipS, wallMs:at.wallMs, belief:result.belief, mapped:result.mapped};
      transitions.push(transition);
      sink.moved.push(transition);
    }
    if (delivered && result.current > voicedStep) {
      voicedStep = result.current;
      // Delivery began at the first decision, even if the sentence goes on to name a later step.
      sentenceNamed = {step:result.current, decidedClipS:sentenceNamed ? sentenceNamed.decidedClipS : at.clipS};
      sink.announcedStep = result.current;
      gateOpen = true;
    }
  }

  /** @param {{value:string,stamp:{clipS:number|null,wallMs:number}}} sentence @param {{clipS:number|null,wallMs:number}} at
   * @param {boolean} delivered @param {{moved:object[],announcedStep:number|null}} sink
   */
  function finishSentence(sentence, at, delivered, sink) {
    const {value, stamp} = sentence;
    if (tracker) applyDecision(tracker.endSentence(at.clipS ?? 0), stamp, at, delivered, sink);
    const named = sentenceNamed;
    sentenceNamed = null;
    const row = {clipS:stamp.clipS, wallMs:stamp.wallMs, value:value.slice(0, MAX_SENTENCE_CHARS), announced:named !== null, step:named ? named.step : null,
      ...(named ? {decidedClipS:named.decidedClipS} : {})};
    if (sentences.length < MAX_SENTENCES) sentences.push(row);
    else droppedSentences++;
    if (openReply) openReply.sentences++;
  }

  /** @param {GateItem[]} items */
  function dropHeld(items) {
    for (const item of items) {
      withheld.chars += item.text.length;
      if (item.audio) withheld.audioBytes += Math.floor(item.audio.length * 3 / 4);
    }
    if (items.length && !turnWithheld) {
      turnWithheld = true;
      withheld.replies++;
    }
  }

  function endGateTurn() {
    gateOpen = false;
    held = [];
    turnWithheld = false;
  }

  return {
    procedure, videoId, startedAtMs, tracker, wizard,
    /** @param {{show?:boolean,speak?:boolean}} flags */
    setGate(flags) {
      if (flags.show !== undefined) showOnly = flags.show;
      if (flags.speak !== undefined) speakOnly = flags.speak;
    },

    /** @param {string} id @param {TurnKind} kind @param {number} wallMs */
    inputQueued(id, kind, wallMs) {
      const row = addTurn(kind, {inputId:id, queuedAtMs:wallMs});
      openInputs.push(row);
      if (kind === "request") requestId = id;
      if (kind === "request" && hold) hold = {...hold, stage:"preparing"};
      return row;
    },
    /** @param {string} id @param {string} state @param {number} wallMs @param {string} [detail] */
    inputStatus(id, state, wallMs, detail) {
      const row = openInputs.find(item => item.inputId === id);
      if (row) {
        if (state === "sending") row.sendingAtMs ??= wallMs;
        if (state === "sent" || state === "waiting") row.sentAtMs ??= wallMs;
        if (state === "failed" || state === "cancelled") {
          openInputs.splice(openInputs.indexOf(row), 1);
          closeTurn(row, state, wallMs);
        }
      }
      if (id !== requestId || !hold) return;
      if (state === "sending") hold = {...hold, stage:"sending"};
      if (state === "failed" || state === "cancelled") hold = {...hold, stage:"failed", ...(detail ? {detail} : {})};
    },
    /** @param {number} wallMs */
    voiceStart(wallMs) {
      voiceRow = addTurn("voice", {queuedAtMs:wallMs});
      openInputs.push(voiceRow);
    },
    /** @param {number} wallMs */
    voiceEnd(wallMs) {
      if (voiceRow) voiceRow.sentAtMs ??= wallMs;
      voiceRow = null;
    },
    /** @param {{computeMs?:number,inputAgeMs?:number}} values */
    noteRuntime(values) {
      runtime = {...runtime, ...values};
    },

    /** @param {number} wallMs @param {{videoHeld:boolean}} options */
    beginHold(wallMs, {videoHeld}) {
      hold = {stage:videoHeld ? "waiting_session" : "not_held", startedAtMs:wallMs};
    },
    /** @param {string} detail */
    holdUnavailable(detail) {
      if (hold) hold = {...hold, stage:"unavailable", detail};
    },
    playbackHasStarted: () => playbackStartedAtMs !== null,
    holdActive: () => hold !== null && hold.endedAtMs === undefined && hold.stage !== "not_held",
    isRequest: (/** @type {string} */ id) => id === requestId,
    /** @param {number} wallMs @param {'request_sent'|'user_skipped'|'no_video_hold'} reason */
    playbackStarted(wallMs, reason) {
      playbackStartedAtMs ??= wallMs;
      if (hold) hold = {...hold, stage:reason === "user_skipped" ? "skipped" : "playing", endedAtMs:hold.endedAtMs ?? wallMs};
      nextDueS = procedure?.checkIns.enabled ? procedure.checkIns.intervalS : null;
    },
    /** @param {number} wallMs */
    cancelHold(wallMs) {
      if (hold && hold.endedAtMs === undefined) hold = {...hold, stage:"cancelled", endedAtMs:wallMs};
    },

    /** Splits text into sentences, updates the tracker and applies the new-step gate.
     * @param {{text?:string,audio?:string|null,unit?:number,final?:boolean,interrupted?:boolean,clipS:number|null,wallMs:number}} chunk
     */
    replyChunk({text = "", audio = null, unit, final = false, interrupted = false, clipS, wallMs}) {
      const presentable = text.trim().length > 0;
      let row = openReply;
      if (audio) {
        withheld.spokenBytes += Math.floor(audio.length * 3 / 4);
        // Audio with no text yet (a silent tick, for one) is not a turn by itself.
        earlyAudioAtMs ??= wallMs;
      }
      if (presentable) {
        row = replyRow(wallMs);
        if (row.firstTextAtMs === undefined) {
          row.firstTextAtMs = wallMs;
          row.computeMs = runtime.computeMs;
          row.inputAgeMs = runtime.inputAgeMs;
        }
      }
      if (row) {
        row.replyChars += text.length;
        if (earlyAudioAtMs !== null) row.firstAudioAtMs ??= earlyAudioAtMs;
      }
      if (row || final || interrupted) earlyAudioAtMs = null;
      const stamp = {clipS, wallMs};
      const delivered = !(interrupted && replyWithheld());
      const done = splitter.push(text, stamp);
      if (final || interrupted) done.push(...splitter.flush(stamp));
      /** @type {{moved:any[],announcedStep:number|null}} */
      const sink = {moved:[], announcedStep:null};
      for (const sentence of done) {
        if (tracker) applyDecision(tracker.observeKnown(clipS ?? 0, sentence.value), sentence.stamp, stamp, delivered, sink);
        finishSentence(sentence, stamp, delivered, sink);
      }
      // Words of the next sentence that are already known can decide now.
      if (tracker) {
        for (const sentence of splitter.peek()) applyDecision(tracker.observeKnown(clipS ?? 0, sentence.value), sentence.stamp, stamp, delivered, sink);
      }

      const holdText = showOnly && !!tracker;
      const holdAudio = speakOnly && !!tracker;
      /** @type {GateItem[]} */
      const release = [];
      // A filter turned off during a reply lets go of what it held, ahead of this
      // chunk, so nothing plays out of order.
      /** @type {GateItem[]} */
      const remaining = [];
      for (const entry of held) {
        const freed = {text:holdText ? "" : entry.text, audio:holdAudio ? null : entry.audio, unit:entry.unit};
        const kept = {text:holdText ? entry.text : "", audio:holdAudio ? entry.audio : null, unit:entry.unit};
        if (freed.text || freed.audio) release.push(freed);
        if (kept.text || kept.audio) remaining.push(kept);
      }
      held = remaining;
      /** @type {GateItem[]} */
      let dropped = [];
      let passText = holdText ? "" : text;
      let passAudio = holdAudio ? null : audio;
      if (release.length) {
        if (passText || passAudio) release.push({text:passText, audio:passAudio, unit});
        passText = "";
        passAudio = null;
      }
      if (holdText || holdAudio) {
        const item = {text:holdText ? text : "", audio:holdAudio ? audio : null, unit};
        if (gateOpen) {
          release.push(...held, item);
          held = [];
        } else {
          if (item.text || item.audio) held.push(item);
          if (final || interrupted) {
            dropped = held;
            held = [];
          } else if (done.length) {
            // The sentence ended without a new step. Keep only the unit that
            // may already hold the start of the next sentence.
            const keep = splitter.pending() ? held.splice(-1) : [];
            dropped = held;
            held = keep;
          }
        }
        dropHeld(dropped);
      }
      if (final || interrupted) {
        endGateTurn();
        if (row && row === openReply) {
          closeTurn(row, interrupted ? "interrupted" : "complete", wallMs);
          openReply = null;
        }
      }
      return {text:passText, audio:passAudio, release, dropped, transitions:sink.moved, announcedStep:sink.announcedStep, sentences:done.length};
    },

    /** Local playback interruption: later text from this reply is discarded.
     * @param {{clipS:number|null,wallMs:number}} stamp
     */
    interrupt(stamp) {
      earlyAudioAtMs = null;
      // Its known words were already judged as they arrived, so this can only pass time.
      for (const sentence of splitter.flush(stamp)) finishSentence(sentence, stamp, false, {moved:[], announcedStep:null});
      dropHeld(held);
      endGateTurn();
      if (openReply) {
        closeTurn(openReply, "interrupted", stamp.wallMs);
        openReply = null;
      }
    },

    /** Decides whether a scheduled check-in goes now, waits or is skipped.
     * @param {{clipS:number,wallMs:number,playing:boolean,busy:boolean,replying:boolean,speaking:boolean,typedAvailable:boolean}} state
     */
    checkInTick({clipS, wallMs, playing, busy, replying, speaking, typedAvailable}) {
      if (!procedure?.checkIns.enabled || nextDueS === null) return null;
      const interval = procedure.checkIns.intervalS;
      if (pendingCheckIn === null && clipS >= nextDueS) {
        pendingCheckIn = {index:++checkInIndex, dueS:nextDueS, reason:null};
        // After a seek forward, keep the original grid instead of a catch-up burst.
        nextDueS = (Math.floor(clipS / interval) + 1) * interval;
      }
      if (pendingCheckIn === null) return null;
      const pending = pendingCheckIn;
      const blocked = !typedAvailable ? "typed_unavailable" : !playing ? "video_paused" : speaking ? "user_speaking"
        : busy ? "input_busy" : replying ? "model_replying" : null;
      const expired = clipS - pending.dueS >= interval * MAX_DEFER_FRACTION || clipS < pending.dueS;
      /** @param {string} state @param {{reason?:string,queuedClipS?:number}} extra */
      const finish = (state, extra) => {
        const record = {index:pending.index, dueS:pending.dueS, state, wallMs, ...extra};
        if (checkIns.length < MAX_CHECK_INS) checkIns.push({...record});
        pendingCheckIn = null;
        return record;
      };
      // Past its deadline it is skipped even if the model is free now, so it never lands late.
      if (expired) return finish("skipped", {reason:blocked ?? pending.reason ?? "late"});
      // Only a delivery result makes it sent. See checkInResult.
      if (!blocked) return finish("queued", {queuedClipS:clipS});
      pending.reason = blocked;
      return null;
    },

    /** Records whether a queued check-in reached the model's input. Null if it is not awaiting a result.
     * @param {number} index @param {boolean} delivered @param {{clipS:number|null,wallMs:number}} stamp
     */
    checkInResult(index, delivered, {clipS, wallMs}) {
      const row = checkIns.find(item => item.index === index && item.state === "queued");
      if (!row) return null;
      row.state = delivered ? "sent" : "failed";
      row.resultWallMs = wallMs;
      if (delivered && clipS !== null) row.sentClipS = clipS;
      return {...row};
    },

    /** @param {number} wallMs */
    takeClosedTurns() {
      const out = closedTurns;
      closedTurns = [];
      return out;
    },

    /** Plain state for the debug panel and step display.
     * @param {number} wallMs @param {number|null} [clipS]
     */
    view(wallMs, clipS = null) {
      const base = playbackStartedAtMs ?? startedAtMs;
      const minutes = Math.max(MIN_RATE_WINDOW_S, (wallMs - base) / 1000) / 60;
      const announcedCount = sentences.reduce((sum, row) => sum + (row.announced ? 1 : 0), 0);
      /** @param {string} state */
      const checkInCount = state => checkIns.filter(row => row.state === state).length;
      return {
        wizard,
        procedureEnabled:!!procedure,
        task:procedure?.task ?? "",
        steps:procedure?.steps ?? [],
        trackerEnabled:!!tracker,
        currentStep:tracker ? tracker.current() : -1,
        transitions:transitions.map(row => ({...row})),
        sentenceCount:sentences.length,
        announcedCount,
        sentencesPerMinute:sentences.length / minutes,
        turns:turns.slice(-8).map(turnBreakdown),
        turnCount:turnCounter,
        hold:hold ? {...hold} : null,
        playbackStarted:playbackStartedAtMs !== null,
        videoId,
        clipS,
        showOnlyNewSteps:showOnly,
        speakOnlyNewSteps:speakOnly,
        withheld:{replies:withheld.replies, chars:withheld.chars, audioMs:withheld.audioBytes / AUDIO_BYTES_PER_MS, spokenMs:withheld.spokenBytes / AUDIO_BYTES_PER_MS},
        checkIns:{enabled:!!procedure?.checkIns.enabled, intervalS:procedure?.checkIns.intervalS ?? 0, sent:checkInCount("sent"),
          queued:checkInCount("queued"), failed:checkInCount("failed"), skipped:checkInCount("skipped"), lastReason:checkIns.findLast(row => row.reason)?.reason ?? null,
          nextDueS:pendingCheckIn?.dueS ?? nextDueS},
      };
    },

    /** Text-bearing record for the opt-in session log and predictions export.
     * Reads only: a download during a reply must not change what happens next.
     */
    exportForLog() {
      const unfinished = splitter.peek().map(({value, stamp}) => ({clipS:stamp.clipS, wallMs:stamp.wallMs,
        value:value.slice(0, MAX_SENTENCE_CHARS), announced:sentenceNamed !== null, step:sentenceNamed ? sentenceNamed.step : null,
        ...(sentenceNamed ? {decidedClipS:sentenceNamed.decidedClipS} : {}), partial:true}));
      return {
        wizardOfOz:wizard,
        videoId, playbackStartedAtMs, droppedSentences,
        trackerParams:tracker ? {...TRACKER_PARAMS} : null,
        procedure:procedure ? {task:procedure.task, steps:[...procedure.steps], instruction:procedure.instruction, prompt:procedure.prompt,
          responsePolicy:procedure.responsePolicy, checkIns:{...procedure.checkIns}, tracker:procedure.tracker,
          showOnlyNewSteps:showOnly, speakOnlyNewSteps:speakOnly} : null,
        sentences:[...sentences.map(row => ({...row})), ...unfinished],
        transitions:transitions.map(row => ({...row})),
        checkIns:checkIns.map(row => ({...row})),
        turns:turns.map(turnBreakdown),
      };
    },
  };
}

/** @param {unknown} v @returns {v is Record<string,unknown>} */
function record(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
/** @param {unknown} v @returns {v is number} */
function finite(v) { return typeof v === "number" && Number.isFinite(v); }
/** @param {unknown} v @param {number} limit */
function str(v, limit) { return typeof v === "string" ? v.slice(0, limit) : ""; }

/** Stored logs are untrusted: rebuild through this allowlist before use.
 * @param {unknown} value
 */
export function cleanRunExport(value) {
  if (!record(value)) return null;
  const list = (/** @type {unknown} */ v, /** @type {number} */ limit) => Array.isArray(v) ? v.slice(0, limit).filter(record) : [];
  const p = value.procedure;
  return {
    wizardOfOz:value.wizardOfOz === true,
    videoId:typeof value.videoId === "string" && value.videoId.length <= 512 ? value.videoId : null,
    playbackStartedAtMs:finite(value.playbackStartedAtMs) ? value.playbackStartedAtMs : null,
    droppedSentences:finite(value.droppedSentences) ? value.droppedSentences : 0,
    trackerParams:record(value.trackerParams) ? Object.fromEntries(Object.entries(value.trackerParams).filter(([, v]) => finite(v))) : null,
    procedure:record(p) ? {
      task:str(p.task, 1000), steps:Array.isArray(p.steps) ? p.steps.slice(0, 64).filter(s => typeof s === "string").map(s => s.slice(0, 1000)) : [],
      instruction:str(p.instruction, 2000), prompt:str(p.prompt, 64_000), responsePolicy:str(p.responsePolicy, 32),
      checkIns:record(p.checkIns) ? {enabled:p.checkIns.enabled === true, intervalS:finite(p.checkIns.intervalS) ? p.checkIns.intervalS : 0, text:str(p.checkIns.text, 2000)} : null,
      tracker:p.tracker === true, showOnlyNewSteps:p.showOnlyNewSteps === true, speakOnlyNewSteps:p.speakOnlyNewSteps === true,
    } : null,
    sentences:list(value.sentences, MAX_SENTENCES).flatMap(row => typeof row.value === "string" && finite(row.wallMs) ? [{
      clipS:finite(row.clipS) ? row.clipS : null, wallMs:row.wallMs, value:row.value.slice(0, MAX_SENTENCE_CHARS),
      announced:row.announced === true, step:finite(row.step) ? row.step : null,
      ...(finite(row.decidedClipS) ? {decidedClipS:row.decidedClipS} : {}),
      ...(row.partial === true ? {partial:true} : {}),
    }] : []),
    transitions:list(value.transitions, MAX_SENTENCES).flatMap(row => finite(row.to) && finite(row.wallMs) ? [{
      from:finite(row.from) ? row.from : -1, to:row.to, clipS:finite(row.clipS) ? row.clipS : null,
      decidedClipS:finite(row.decidedClipS) ? row.decidedClipS : null, wallMs:row.wallMs,
      belief:finite(row.belief) ? row.belief : 0, mapped:finite(row.mapped) ? row.mapped : null,
    }] : []),
    checkIns:list(value.checkIns, MAX_CHECK_INS).flatMap(row => finite(row.index) && finite(row.dueS) && finite(row.wallMs) && ["queued", "sent", "failed", "skipped"].includes(String(row.state)) ? [{
      index:row.index, dueS:row.dueS, state:row.state, wallMs:row.wallMs,
      ...(typeof row.reason === "string" ? {reason:row.reason.slice(0, 32)} : {}),
      ...(finite(row.queuedClipS) ? {queuedClipS:row.queuedClipS} : {}),
      ...(finite(row.sentClipS) ? {sentClipS:row.sentClipS} : {}),
      ...(finite(row.resultWallMs) ? {resultWallMs:row.resultWallMs} : {}),
    }] : []),
    turns:list(value.turns, MAX_TURNS).flatMap(row => {
      if (!finite(row.index) || typeof row.kind !== "string" || typeof row.status !== "string") return [];
      const keys = ["prepareMs", "deliveryMs", "firstTextMs", "firstAudioMs", "replyMs", "computeMs", "inputAgeMs"];
      return [{index:row.index, kind:row.kind.slice(0, 16), status:row.status.slice(0, 16),
        replyChars:finite(row.replyChars) ? row.replyChars : 0, sentences:finite(row.sentences) ? row.sentences : 0,
        ...Object.fromEntries(keys.map(key => [key, finite(row[key]) ? row[key] : null]))}];
    }),
  };
}

/** SPOT-Bench layout: {video_id: [{time, type: "response", value}]}.
 * Values are always the model's own sentences, never the supplied step text.
 * Replies that arrived before playback keep their negative time, so opening
 * speech is not credited to the first frame. A filtered sentence reached the user
 * when the filter let it through, so "announced" uses that time.
 * @param {{videoId:string|null,playbackStartedAtMs:number|null,sentences:{clipS:number|null,wallMs:number,value:string,announced:boolean,decidedClipS?:number|null}[]}|null} run
 * @param {'all'|'announced'} [filter]
 */
export function predictionsFromRun(run, filter = "all") {
  if (!run?.videoId) return null;
  const events = [];
  for (const row of run.sentences) {
    if (filter === "announced" && !row.announced) continue;
    const clip = filter === "announced" ? row.decidedClipS ?? row.clipS : row.clipS;
    const time = clip ?? (run.playbackStartedAtMs !== null ? (row.wallMs - run.playbackStartedAtMs) / 1000 : null);
    if (time === null) continue;
    events.push({time:round3(time), type:"response", value:row.value});
  }
  return {[run.videoId]:events};
}

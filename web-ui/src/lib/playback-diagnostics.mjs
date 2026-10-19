/** @typedef {'microphone'|'typed'|'server'|'input-transcription'} StopReason */
/** @typedef {{receivedBytes:number, queuedBytes:number, discardedBytes:number, interruptions:number, micInterruptions:number, lastReason:StopReason|null}} PlaybackDiagnostics */
/** @returns {PlaybackDiagnostics} */
export function emptyPlaybackDiagnostics() {
  return {receivedBytes:0, queuedBytes:0, discardedBytes:0, interruptions:0, micInterruptions:0, lastReason:null};
}

/**
 * Content-free transport counters. Queued audio is not proof of audible playback.
 * @param {PlaybackDiagnostics} state
 * @param {{type:'audio',bytes:number,discarded:boolean}|{type:'interrupt',reason:StopReason}} event
 * @returns {PlaybackDiagnostics}
 */
export function recordPlaybackEvent(state, event) {
  if (event.type === 'interrupt') return {...state,
    interruptions:state.interruptions + 1,
    micInterruptions:state.micInterruptions + Number(event.reason === 'microphone'),
    lastReason:event.reason};
  return {...state, receivedBytes:state.receivedBytes + event.bytes,
    queuedBytes:state.queuedBytes + (event.discarded ? 0 : event.bytes),
    discardedBytes:state.discardedBytes + (event.discarded ? event.bytes : 0)};
}

/** @typedef {{id:string, role:'user', source:'voice'|'typed', text:string, streaming:boolean, revision:number, turnOrder:number, status:string, statusDetail?:string}} InputEntry */
/** @typedef {{text:string, label:string, streaming:boolean, turnOrder:number, inputId:string}} InputCaption */
/** @typedef {{sessionId:string|null, generation:number, latestOrder:number, acceptedInputOrder?:number, pendingId:string|null, busy:boolean, caption:InputCaption|null, entries:InputEntry[], status:string, statusSource:'voice'|'typed'|null}} InputFeedback */

/** @param {string|null} sessionId @returns {InputFeedback} */
export function emptyInputFeedback(sessionId = null) {
  return {sessionId, generation:0, latestOrder:0, acceptedInputOrder:0, pendingId:null, busy:false, caption:null, entries:[], status:'', statusSource:null};
}

export const inputStatusLabels = {
  transcribing:'Transcribing microphone…', preparing:'Preparing typed speech…',
  sending:'Sending typed instruction…', sent:'Instruction sent', waiting:'Sent · waiting for a response',
  failed:'Input unavailable', cancelled:'Cancelled',
};

/** Pure ordering prevents delayed ASR from replacing newer captions.
 * @param {InputFeedback} state
 * @param {import('./protocol').InputFeedbackEvent} event
 * @returns {InputFeedback}
 */
export function reduceInputFeedback(state, event) {
  if ('session_id' in event && event.session_id !== state.sessionId) return state;
  if (event.type === 'microphone') {
    return {...state, generation:event.generation,
      status:state.statusSource === 'voice' ? '' : state.status,
      statusSource:state.statusSource === 'voice' ? null : state.statusSource,
      caption:state.caption?.label === 'You · voice' ? null : state.caption,
      entries:state.entries.map(e => e.source === 'voice' && e.streaming ? {...e,streaming:false,status:'cancelled',statusDetail:undefined} : e)};
  }
  if (event.type === 'assistant') {
    const order = event.turn_order ?? state.latestOrder + 1;
    return {...state, latestOrder:Math.max(order,state.latestOrder),
      caption:!state.pendingId && (!state.caption || order >= state.caption.turnOrder) ? null : state.caption,
      status:!state.busy && order >= state.latestOrder ? '' : state.status};
  }
  if (event.type === 'typed') {
    const status = event.transport === 'text' ? 'sending' : 'preparing';
    const entry = {id:event.input_id,role:/** @type {'user'} */('user'),source:/** @type {'typed'} */('typed'),text:event.text,streaming:false,revision:0,turnOrder:state.latestOrder+1,status};
    return {...state,pendingId:entry.id,busy:true,status:inputStatusLabels[status],statusSource:'typed',entries:[...state.entries,entry],
      caption:{text:entry.text,label:'You · typed',streaming:false,turnOrder:entry.turnOrder,inputId:entry.id}};
  }
  if ((event.type === 'input.transcription' || event.source === 'voice') && event.generation !== state.generation) return state;
  if (event.type === 'input.transcription') {
    const previous = state.entries.find(e => e.id === event.utterance_id);
    if (previous && (previous.revision >= event.revision || !previous.streaming)) return state;
    const noSpeech = event.final && !event.text.trim();
    const entry = {id:event.utterance_id,role:/** @type {'user'} */('user'),source:/** @type {'voice'} */('voice'),text:event.text,
      streaming:!event.final,revision:event.revision,turnOrder:event.turn_order,status:noSpeech ? 'no_speech' : event.final ? 'transcribed' : 'transcribing'};
    const entries = previous ? state.entries.map(e => e.id === entry.id ? entry : e) : [...state.entries,entry];
    const newest = !state.pendingId && event.turn_order >= state.latestOrder;
    return {...state,entries,latestOrder:Math.max(state.latestOrder,event.turn_order),
      // ASR progress/no-speech still has an order for display, but only actual
      // recognized instructions may supersede a response already in flight.
      acceptedInputOrder:!state.pendingId && event.text.trim() ? Math.max(state.acceptedInputOrder ?? 0,event.turn_order) : state.acceptedInputOrder ?? 0,
      status:newest ? (noSpeech ? 'No speech recognized for caption' : event.final ? 'Transcribed · waiting for a response' : inputStatusLabels.transcribing) : state.status,
      statusSource:newest ? 'voice' : state.statusSource,
      caption:newest && event.text.trim() ? {text:event.text,label:'You · voice',streaming:!event.final,turnOrder:event.turn_order,inputId:entry.id}
        : event.final && !event.text.trim() && state.caption?.inputId === entry.id ? null : state.caption};
  }
  const terminal = ['waiting','failed','cancelled'].includes(event.state);
  const ownPending = event.input_id === state.pendingId;
  const newest = ownPending || (!state.pendingId && event.turn_order >= state.latestOrder);
  const typedEntry = state.entries.find(e => e.id === event.input_id && e.source === 'typed');
  const typedDelivered = event.source === 'typed' && typedEntry && !['failed','cancelled'].includes(typedEntry.status)
    && ['sent','waiting'].includes(event.state);
  return {...state,latestOrder:Math.max(state.latestOrder,event.turn_order),
    // The optimistic typed order may be inflated by unrelated ASR progress.
    // Pending typed input already gates replies; retain only its server-confirmed
    // delivery order after pending clears, never a failed preparation's guess.
    acceptedInputOrder:typedDelivered ? Math.max(state.acceptedInputOrder ?? 0,event.turn_order) : state.acceptedInputOrder ?? 0,
    pendingId:ownPending && terminal ? null : state.pendingId,
    busy:ownPending && terminal ? false : state.busy,
    status:newest ? event.detail ?? inputStatusLabels[event.state] : state.status,
    statusSource:newest ? event.source : state.statusSource,
    caption:state.caption?.inputId === event.input_id ? {...state.caption,turnOrder:event.turn_order} : state.caption,
    entries:state.entries.map(e => e.id === event.input_id ? {...e,status:event.state,statusDetail:event.detail,turnOrder:event.turn_order,
      streaming:terminal ? false : e.streaming} : e)};
}

# Reply is a chunk, not a buffered utterance

Each Model piece is a Reply. The Client appends Text and queues Audio as they arrive; either field may be empty. `final` ends a generated output turn, not Client playback. JoyAI emits one final chunk per successful HTTP turn; Mock emits two Text/Audio chunks with only the second final. A separate `reply.delta` event would duplicate Reply.

Feeding and Reply forwarding run independently. Future adapters may yield output before a feed call completes without buffering a whole utterance first. The shared interface does not require a local Reply queue or presume any undeployed Model's event names.

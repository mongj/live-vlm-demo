# Audio Buffer is a rolling timeline, not a turn queue

Audio is retained as a bounded, sample-ordered timeline and consumed in complete Model-sized slices. Request slice size and retention duration serve different purposes. Mock uses 0.2-second slices with 1-second retention; these are internal constants, not Client Config. The in-flight slice is no longer in the buffer. Overflow drops the oldest whole samples, bounding waiting media at the cost of possible gaps rather than preserving all speech with growing delay.

Consume returns `None` when no complete slice exists, covering both empty and partial buffers; it does not distinguish those cases. A complete slice leaves the remainder behind. The feeder drains all ready work after a notification so a second complete slice cannot be stranded waiting for new input. Partial Audio waits for more input and is discarded on close, with no flush act. Capacities and slices are whole samples and inbound PCM must have even byte length, so overflow cannot shift the s16 stream by a byte.

JoyAI has zero Audio slice size and retention: its buffer is disabled and ingest never decodes or pushes Audio. These buffers do not promise continuous Audio under overload, A/V synchronization, or upstream generation backpressure.

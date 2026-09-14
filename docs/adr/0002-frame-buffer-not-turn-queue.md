# Frame Buffer, not a turn queue or LIFO stack

Live Frames are held in a bounded buffer of at most `max_frames_per_request` items. This is the maximum per request, not a requirement to wait for a full batch. Overflow drops the oldest Frame. On consume, forward every retained Frame in arrival/capture order as one batch, then clear. The trusted Client supplies Frames in capture order; the server does not sort by timestamp.

The in-flight batch has already left the buffer; it is not included in retention. Keeping `2N` and discarding half at every consume adds no useful history. A turn queue would make answers lag the camera; a LIFO stack would send older Frames after newer ones. A maximum of one naturally keeps only the newest Frame. No per-call batch-size argument or separate retention knob is needed.

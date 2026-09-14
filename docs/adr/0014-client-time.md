# Frame time is Client time

The Client sends Frames in capture order. It either supplies `t` on every Frame for a Session or omits it consistently. Supplied timestamps are elapsed seconds from the Client's Session start, not Unix time. The server trusts them and does not sort, correct drift, or compensate for capture delay.

For the omitted mode, Session records `started_at = time.monotonic()` immediately before acknowledgement and ingest uses `time.monotonic() - started_at`. Never combine Client-relative seconds with absolute monotonic time. Mixing modes or reordering captures is outside the v1 contract; no extra clock protocol is needed.

JoyAI formats Frame times as `frame_time_ranges`. Audio remains sample-arrival-ordered and Text ignores `t`; this is not an A/V synchronization promise.

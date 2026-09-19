# Frame time is Client time

The Client sends Frames in capture order. It either supplies `t` on every Frame for a Session or omits it consistently. Supplied timestamps are absolute Unix time in milliseconds (`Date.now()`), not session-relative seconds. The server trusts them and does not sort, correct drift, or compensate for capture delay.

For the omitted mode, ingest stamps arrival with `time.time() * 1000` so VideoFrame `t` stays in Unix milliseconds. Never combine Unix-ms Client times with monotonic elapsed seconds. Mixing modes or reordering captures is outside the v1 contract; no extra clock protocol is needed.

JoyAI converts Unix-ms `t` to session-relative seconds at the adapter boundary (`(t - open_unix_ms) / 1000`) before formatting `frame_time_ranges`. Audio remains sample-arrival-ordered and Text ignores `t`; this is not an A/V synchronization promise.

Successful visual turns echo the last consumed `input.append` `t` on `response.chunk` so the playground debug view can show the logged send time.

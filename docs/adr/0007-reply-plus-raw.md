# Reply is presentable; Raw is a sidecar

Every successful JoyAI HTTP turn emits one Reply, including silence. Presentable Text comes from `choices[0].message.content`, with display markers removed; `</silence>` yields empty Text. Raw comes separately from `streamingharness.raw_content` and is preserved exactly, including whitespace and an empty string. Forced silence can have empty Raw: do not fabricate a marker, fall back from empty Raw to content, or normalize content by reparsing Raw.

Mock supplies unnormalized mock text per chunk as Raw. Clients must not parse Model dialect to render the default UI. Failed turns produce Errors, not fabricated Replies.

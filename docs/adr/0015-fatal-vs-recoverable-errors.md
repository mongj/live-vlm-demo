# Fatal Errors close the Session; recoverable Errors do not

Use one validation-error path: malformed JSON, unknown message types, binary messages, invalid envelopes/media, Feed-before-Start, and a second Start are recoverable. Unsupported modalities are quiet-dropped. An unknown Model or invalid Config on the first Start, failed open/acknowledgement, unexpected worker failure, or ended Reply iterator is fatal.

A failed JoyAI HTTP turn consumes its batch, emits a recoverable Error, and continues with newer media; no retry or replacement Reply is implied. Keep a human-readable message and fatal flag, not a custom code taxonomy. Normal close uses 1000; a terminal server/session failure uses 1011. Ordinary Client disconnect needs no Error.

The coordinator owns termination. Cancel/gather workers and release the retained adapter even when startup only partially succeeded or acknowledgement failed. Terminal Error delivery and socket close are separate bounded best-effort attempts; neither gates resource cleanup. Workers never close the socket to signal each other, and cancellation remains cancellation after cleanup.

# Playground wire is JSON text frames

Start, Feed, Reply, and Errors are JSON text messages on the WebSocket. JPEG and PCM travel as base64 fields. This keeps the Client contract inspectable and easy to exercise with Mock. Adapters translate their upstream transport independently; a common Client wire format does not require Models to share one. Binary messages and WebRTC are out of scope for v1, not additional ingest paths to implement now.

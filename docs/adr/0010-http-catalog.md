# Catalog is HTTP, Session is WebSocket

The Client discovers Models via HTTP (`GET /v1/models`, `GET /v1/models/{id}`): id, label, and Config schema. The adapter key, Capability, deployment URLs, and reachability are not exposed. Discovery uses the loaded local Catalog and class-level Config schemas, without constructing adapters or performing network I/O. `/health` reports the gateway process only, not GPU readiness.

The WebSocket (`/v1/realtime`) is only for a Session. Putting Catalog discovery on the socket would force a connection to learn names; hardcoding it in the frontend would fork the source of truth. The Catalog is a local config file, not a database.

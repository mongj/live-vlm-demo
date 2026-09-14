# Catalog lives in `config.toml`, not SQLite

Given a socket-bound Session, no Clear, no transcripts, and no presets, SQLite would only store two Model rows. The Catalog is the `[[models]]` section of local `config.toml`, shipped with JoyAI and Mock only. The broader filename can accommodate deliberate application-level sections later, but v1 adds none. Load and validate the Catalog once at startup; there is no hot reload or deferred-model placeholder.

Resolve each row's `base_url` into a frozen ModelSpec before constructing an adapter. JoyAI's webinfer model name is hardcoded in the adapter, not a Catalog field. Adapters do not read environment variables during turns. A database can wait until users, presets, or history require one.

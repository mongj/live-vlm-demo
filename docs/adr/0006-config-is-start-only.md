# Config is Start-only

Config is accepted on Start and cannot change for that Session. JoyAI can send a system-prompt key per HTTP turn, but swapping it mid-Session would make "which Config was this?" undefined. Mock follows the same start-only rule. Changing Config requires a new Session. Unknown keys fail Start rather than being ignored. The same frozen Pydantic Config class supplies validation, defaults, and the published JSON Schema; do not maintain a second schema or expose ineffective upstream knobs.

# Session id is kebab-case `{model-id}-{native}`

The Client-facing Session id is `{model-id}-{native}` in kebab-case (`joyai-vl-a1b2c3d4`). Catalog IDs are kebab-case and at most 64 characters. JoyAI and Mock mint a UUID hex token during open. The Client never invents the id. JoyAI uses the full public id as `x-streaming-session`; this fits webinfer's allowed charset `A-Za-z0-9_.-` and 120-character limit.

A future adapter may normalize a Model-issued token for the public suffix while retaining its exact native id privately. Verify that integration's identity rules then; no undeployed event name is part of v1. A small ID helper suffices and does not dictate separate negotiation/activation lifecycle hooks.

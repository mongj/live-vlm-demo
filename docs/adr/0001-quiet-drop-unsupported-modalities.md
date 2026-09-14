# Quiet-drop modalities outside a Model's Capability

The Client sends a standard Feed (optional Frame, Audio, and Text fields). The server discards what the bound Model cannot use before media decoding or buffering, with no error. Envelope field types still must be valid. Strict rejection would force every Client to branch on Model; a warning-on-first-drop would still special-case the envelope. We do not adapt one Modality into another: JoyAI drops Audio rather than using ASR, while Mock accepts all three. Future integrations must establish their own verified Capability.

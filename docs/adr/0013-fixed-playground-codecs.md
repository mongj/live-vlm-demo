# Fixed playground codecs

The Client wire is JPEG (base64, no data-URL prefix), inbound PCM s16le 16 kHz mono, and outbound PCM s16le 24 kHz mono. Adapters receive raw bytes; ClientChannel base64-encodes outbound Audio. JoyAI wraps JPEG in upstream data URLs and ignores Audio. Mock consumes and generates the fixed PCM formats with standard-library code.

Fixed codecs keep the Client/Mock contract small. Add upstream-specific conversions only when a concrete adapter needs them; no speculative MiniCPM conversion, NumPy dependency, or negotiated-codec framework belongs in v1.

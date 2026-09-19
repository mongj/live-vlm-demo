# Live VLM Playground

The live interaction between a Client and one Model through the playground. Implementation scope and decisions are recorded in [the server plan](docs/plan-web-server.md).

## Language

**Session**:
The live interaction between exactly one Client and one Model, bound to the Client's WebSocket from acknowledged Start until closure or fatal termination. Each Session has a Model-prefixed identity; reconnecting creates a new Session.
_Avoid_: Call, Connection, Conversation

**Start**:
The Client act that binds a Session to one Model and its Config. An acknowledged Start permits Feed; a second Start cannot replace the existing Session.
_Avoid_: connect, handshake, init (as the bind itself)

**Config**:
The Model-specific settings accepted on Start and fixed for the Session. Unknown keys fail Start.
_Avoid_: options, settings, params, hyperparameters

**Instructions**:
The system-level text in a Config. Not Feed Text. A Model that does not take free-text Instructions uses its own Config key instead.
_Avoid_: system prompt, persona, prompt (as the Session setting)

**Client**:
The party that opens the WebSocket — the playground frontend or another application.
_Avoid_: User, browser, frontend (as the protocol party)

**Model**:
A named vision-language system a Session is bound to for its entire life. Different Models accept and emit different modalities.
_Avoid_: Backend, adapter, engine

**Catalog**:
The set of Models the playground can bind a Session to. Each entry carries Config schema. Capability is not part of the Catalog.
_Avoid_: registry, directory, model list

**Capability**:
The modalities a Model can accept and the modalities it can emit. Owned by the adapter; not sent to the Client. The Client always sends a full Feed.
_Avoid_: feature, support, mode

**Modality**:
One of Frame, Audio, or Text as a kind of live payload.
_Avoid_: stream type, media type, channel

**Feed**:
The Client's ongoing Frame, Audio, and Text on a Session, with individual modalities optional in each item. Frames may carry Client time; unsupported modalities are ignored without notice.
_Avoid_: input, stream, media (as the bundle)

**Client time**:
Absolute Unix time in milliseconds (`Date.now()`), attached to capture-ordered Frames and trusted without correction. A Session consistently uses supplied Client times or server-observed Unix-ms arrival times when omitted; neither implies Audio/video synchronization.
_Avoid_: server clock, session-relative seconds (as the playground `t`), frame_time_range (as the playground concept)

**Frame**:
A still image sampled from the camera at a point in time, encoded as JPEG. Not a video file or container. Frames that cannot be delivered immediately do not become a backlog of turns.
_Avoid_: video, image (as the live unit)

**Frame Buffer**:
The bounded set of newest Frames awaiting delivery, with a maximum batch size rather than a requirement to fill a batch. Overflow discards the oldest Frames; delivery takes the retained Frames in capture order and leaves no historical turn backlog.
_Avoid_: window, stack, queue

**Audio**:
A sample-ordered sound payload on the Feed or a Reply, not a sequence of Model turns. Dropping stale samples can create gaps; continuity is not guaranteed under overload.
_Avoid_: clip, utterance, voice (as the live unit)

**Audio Buffer**:
The bounded recent Audio awaiting delivery, with retention duration distinct from the Model's slice size. Delivery takes complete slices and preserves the remainder, while overflow discards the oldest whole samples and Session end discards any incomplete remainder.
_Avoid_: window, ear, queue

**Text**:
A Client utterance on the Feed, whose remembered meaning and timing belong to the Model rather than a playground-wide standing question. JoyAI and Mock use the latest non-empty Text for the next media-triggered turn, without initiating a Text-only turn or changing one already in flight.
_Avoid_: prompt, query, message, question (as a playground-wide object)

**Reply**:
One outbound chunk on a Session, carrying independently optional presentable Text and Audio plus Raw. A final Reply ends a generated output turn, not Client playback; Reply delivery need not wait for Feed completion.
_Avoid_: response, output, completion, message, delta, utterance (as the wire unit)

**Raw**:
The Model's unnormalized outbound text attached to a Reply for inspection, preserved including whitespace or an empty string. It is separate from presentable Text and is not for default display or playback.
_Avoid_: debug, logs, dialect (as the field itself)

**Error**:
A failure report to the Client, distinguishing recoverable failures from fatal failures that end the Session. Fatal termination does not depend on successful delivery of the report; normal Client disconnect is not an Error.
_Avoid_: exception, fault, status

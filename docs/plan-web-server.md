# Web Server Implementation Plan

Build a Python gateway in `live-vlm-demo/web-server` with an HTTP Model Catalog and a JSON WebSocket Session API. V1 supports **JoyAI-VL and an in-process Mock**. Sections 1–11 specify the finished server; §12 divides implementation into reviewable phases.

Domain language is in [CONTEXT.md](../CONTEXT.md). Rationale for non-obvious decisions is in [docs/adr/](./adr/).

Implementation should be explicit and easy for lab members to trace. Classes own concrete state and resources: Session, ClientChannel, buffers, and adapters. The service is a trusted-user playground bound to localhost by default.

## 1. Scope and architecture

```text
Client
  ├── HTTP GET /v1/models ──> local Catalog + Config schemas
  └── WS /v1/realtime ─────> Session coordinator
                              ├── receiver ──> Frame/Audio Buffers + adapter Text
                              ├── feeder ────> adapter.send_feed(...)
                              └── forwarder <─ adapter.read_replies()
                                                   │
                                      ┌────────────┴─────────────┐
                                      JoyAI                     Mock
                                HTTP webinfer :8070         in-process
                                         │
                                   vLLM :7060
```

The Client sends a standard Feed: JPEG Frames, PCM Audio, and Text. Each field is optional on an individual Feed. Unsupported modalities are quiet-dropped. The Client receives standard Reply chunks with presentable Text/Audio, Raw, and `final`.

- JoyAI consumes Frames and Text, ignores Audio, and returns one text-only Reply per HTTP turn.
- Mock consumes Frames, Audio, and Text and returns two Text/Audio chunks per simulated turn.
- Feeding and Reply forwarding run independently, so output may arrive while a feed call is still running.
- Each WebSocket owns one Session bound to one Model. Reconnection creates a new Session.
- Session owns worker lifetimes and buffers. Each adapter owns its model-specific state and transport. ClientChannel owns outbound WebSocket writes.

The checked-in launcher runs webinfer on compute-node loopback port 8070 and connects it to vLLM on port 7060. See §8 and §10.

## 2. Package layout and dependencies

```text
web-server/
  pyproject.toml
  README.md
  config.toml             # application config; v1 contains the Model Catalog
  src/live_vlm_server/
    __init__.py
    __main__.py            # python -m live_vlm_server; bind env/defaults
    main.py                # app factory, routes, startup Catalog loading
    catalog.py             # model TOML loading, validation, adapter registry
    types.py               # ModelSpec, VideoFrame, Reply, SessionError, ID helper
    protocol.py            # Pydantic wire models and inbound discriminated union
    codecs.py              # playground base64, JPEG and PCM byte checks
    buffers.py             # synchronous FrameBuffer and AudioBuffer
    channel.py             # serialized outbound writes; no shutdown decisions
    session.py             # Session, coordinator, ingest, feeder, forwarder
    adapters/
      __init__.py
      base.py              # small typed adapter interface
      joyai.py
      mock.py
  tests/
    test_types.py
    test_catalog.py
    test_http.py
    test_protocol.py
    test_buffers.py
    test_joyai.py
    test_mock.py
    test_session.py
```

Runtime dependencies: Python 3.12+, FastAPI, Uvicorn with WebSocket support, Pydantic v2, and HTTPX. Development dependencies: pytest, pytest-asyncio, and mypy, exposed through a `dev` dependency extra. Each phase runs `python -m pytest` and `python -m mypy src tests`. Mock generates PCM with the standard library.

Dependencies stay one-way:

```text
types / buffers / codecs / protocol   no application-layer imports
adapters                             types, buffers, standard/external libraries
catalog                              types, adapters
channel                              types, protocol, codecs
session                              types, buffers, adapters, channel, protocol, codecs
main                                 catalog, session, channel
```

`main` passes resolved Catalog data to the Session handler. Adapters receive a frozen `ModelSpec` and their own validated Config. Environment and TOML access occur during process startup only.

## 3. HTTP Catalog and model deployment configuration

### 3.1 Source of truth

`web-server/config.toml`:

```toml
[[models]]
id = "joyai-vl"
adapter = "joyai"
label = "JoyAI-VL-Interaction"
base_url = "http://127.0.0.1:8070/v1"

[[models]]
id = "mock"
adapter = "mock"
label = "Mock"
```

The finished v1 file contains these two rows. Phase 3 initially adds the Mock row; Phase 5 adds JoyAI when its adapter is ready.

| Value      | Ownership and resolution                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`       | Unique public Catalog identity; what Start selects. Kebab-case, at most 64 characters.                                 |
| `adapter`  | Key in the explicit `{"joyai": JoyAIAdapter, "mock": MockAdapter}` server registry.                                    |
| `label`    | Client display name.                                                                                                   |
| `base_url` | Adapter-specific endpoint. Required for JoyAI; absent for Mock. Edit this value when the tunnel or local port differs. |

In v1, `config.toml` contains the Model Catalog. The Catalog loader reads `[[models]]` into frozen `ModelSpec(id, adapter, label, base_url)` values.

The run entry point reads these environment variables:

| Variable          | Default         | Purpose                                                               |
| ----------------- | --------------- | --------------------------------------------------------------------- |
| `LIVE_VLM_CONFIG` | `./config.toml` | Path to application config; relative to the process working directory |
| `LIVE_VLM_HOST`   | `127.0.0.1`     | Gateway bind host                                                     |
| `LIVE_VLM_PORT`   | `8787`          | Gateway bind port                                                     |

Validate `LIVE_VLM_PORT` as an integer from 1 through 65535. `python -m live_vlm_server` passes the resolved config path to `create_app(config_path)` and starts Uvicorn. The README run command starts from `web-server`, making the default config path unambiguous. Tests pass a temporary config path directly to `create_app`.

Load the Catalog once at application startup. Reject a missing file, malformed TOML, duplicate IDs, invalid IDs, unknown adapter keys, and a missing JoyAI `base_url`. Require an HTTP(S) JoyAI base URL ending in `/v1`; normalize a trailing slash. Catalog loading performs no network I/O.

### 3.2 Routes

| Method | Path              | Result                                      |
| ------ | ----------------- | ------------------------------------------- |
| GET    | `/health`         | `{"ok": true}`; gateway process health only |
| GET    | `/v1/models`      | All Catalog entries                         |
| GET    | `/v1/models/{id}` | One entry; 404 if absent                    |
| WS     | `/v1/realtime`    | Session protocol                            |

An entry exposes `id`, `label`, and `config_schema`. Catalog requests read loaded data and class-level Config schemas without constructing adapters or accessing the network.

`config_schema` is emitted verbatim by the adapter's Pydantic Config class via `model_json_schema()`. Start validates with that same class, making it the single source for schema, defaults, and validation.

`GET /v1/models` returns `{"models": [<entry>, ...]}`. `GET /v1/models/{id}` returns one entry directly. The three entry fields are present for every Model.

### 3.3 Client Config

Both Config models use `ConfigDict(extra="forbid", frozen=True)`.

```python
class JoyAIConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    system_prompt_key: Literal[
        "DEFAULT_SYSTEM_PROMPT_EN",
        "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION",
    ] = "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION"
    max_frames_per_request: int = Field(default=1, ge=1, le=8)


class MockConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    latency_ms: int = Field(default=150, ge=0, le=5000)
```

`max_frames_per_request` is a maximum: any nonempty Frame batch is eligible immediately. The JoyAI request uses the fixed generation settings owned by webinfer. The no-delegation prompt is the default because this PBS stack does not run the background agent. Mock's media limits are adapter constants.

## 4. WebSocket contract

All messages are JSON text frames. Binary messages are unsupported. JPEG and PCM fields use standard base64 without a data-URL prefix.

| Type              | Direction       | Meaning                                                    |
| ----------------- | --------------- | ---------------------------------------------------------- |
| `session.start`   | Client → server | Select one Model and start-only Config                     |
| `session.started` | Server → Client | Binding completed; includes effective Config               |
| `input.append`    | Client → server | Feed with optional Frame, Audio, Text, and Frame timestamp |
| `response.chunk`  | Server → Client | One Reply                                                  |
| `error`           | Server → Client | Human-readable failure and `fatal` flag                    |

Socket close ends the Session. The v1 message set is exactly the five types above.

### 4.1 Wire examples

```json
{
  "type": "session.start",
  "model": "joyai-vl",
  "config": {
    "system_prompt_key": "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION",
    "max_frames_per_request": 2
  }
}
```

```json
{
  "type": "session.started",
  "session_id": "joyai-vl-a1b2c3d4",
  "model": "joyai-vl",
  "config": {
    "system_prompt_key": "DEFAULT_SYSTEM_PROMPT_NO_DELEGATION",
    "max_frames_per_request": 2
  }
}
```

```json
{
  "type": "input.append",
  "frame": "<jpeg base64 or null>",
  "audio": "<pcm base64 or null>",
  "text": "What is on the desk?",
  "t": 1726700000123
}
```

```json
{
  "type": "response.chunk",
  "session_id": "joyai-vl-a1b2c3d4",
  "text": "A laptop is open.",
  "audio": null,
  "raw": "</response> A laptop is open.",
  "final": true,
  "t": 1726700000123
}
```

```json
{
  "type": "error",
  "session_id": null,
  "fatal": false,
  "message": "Feed before Start is ignored"
}
```

`config` defaults to an empty object. Feed fields may be omitted or null. `session.started.config` contains all effective defaults. Every Reply carries the bound Session ID; Errors before binding use null.

### 4.2 Codecs, time, and validation

| Payload        | Fixed encoding          |
| -------------- | ----------------------- |
| Frame          | JPEG                    |
| Inbound Audio  | PCM s16le, 16 kHz, mono |
| Outbound Audio | PCM s16le, 24 kHz, mono |

Define `MAX_MEDIA_B64_CHARS = 4 * 1024 * 1024`. For an accepted media field, reject a base64 string longer than that before decoding it. Decode with strict base64 validation. Frame bytes must start with the JPEG SOI marker `FF D8`; PCM must contain an even number of bytes. These checks produce a recoverable Error.

Quiet-drop unsupported media before the size and byte checks. Pydantic still validates its envelope type. Ingest processes Frame, Audio, then Text; a valid earlier field remains buffered if a later field is invalid.

Frames arrive in capture order from a trusted Client. For the whole Session, the Client either supplies `t` on every Frame or omits it on every Frame:

- Supplied `t` is absolute Unix time in milliseconds (`Date.now()`), not session-relative seconds. Trust the values and ordering; do not sort by timestamp.
- If omitted, ingest uses `time.time() * 1000` so VideoFrame `t` stays in Unix milliseconds.
- The Client uses one timestamp mode throughout a Session. The server does not track or enforce that choice; arrival order controls buffering.
- `t` annotates the Frame only. Audio is ordered by sample arrival; Text does not use it.

Use Pydantic models with `ConfigDict(extra="forbid")`, literal `type` strings, and one discriminated inbound union (`session.start` / `input.append`). The parser maps malformed JSON, unknown message types, and Pydantic validation failures to the same recoverable Error path. Require `t` to be finite and non-negative when supplied.

### 4.3 Reply meaning

A `Reply(text="", audio=None, raw="", final=False, t=None)` holds raw PCM bytes internally, never playground base64. It has no Session ID. `t` is the last consumed `input.append` Unix-ms timestamp when the turn had Frames. ClientChannel supplies the ID, encodes Audio, and echoes `t` on `response.chunk` when present.

Text and Audio are independent; either can be empty. Clients append presentable Text and queue Audio as chunks arrive. `final` ends a generated output turn, not Client playback. Raw preserves the adapter's unnormalized model text; it may legitimately be empty. Clients must not parse JoyAI markers to render the default UI.

## 5. Session ownership, scheduling, and shutdown

### 5.1 Owners

- **Session coordinator:** the WebSocket route coroutine. Retains the adapter, owns startup/shutdown and task handles.
- **Session:** the bound ID/model, adapter reference, Frame/Audio Buffers, and `asyncio.Event`.
- **ClientChannel:** the only outbound writer. Uses one async lock for JSON writes, adds Session IDs, and encodes Reply Audio. It does not decide when the Session ends.
- **Adapter:** model-specific Config, query state, transport resources, and Reply delivery. Constructors allocate no external resources.

Keep all inbound handling serial. Buffer methods and `offer_text` are synchronous and contain no await. Only the outbound ClientChannel requires a lock.

### 5.2 Startup

Implement the route with one outer `try/finally` covering these steps:

1. Accept the WebSocket and create ClientChannel. Initialize the retained adapter to null and the owned-task collection to empty.
2. Read until a valid Start. Invalid messages and Feed-before-Start yield recoverable Errors and are discarded, not buffered.
3. Resolve the Catalog row and validate its Config. An unknown Model or invalid Config on the first Start is fatal.
4. Construct the adapter and immediately assign it to the coordinator's retained variable, **before awaiting anything**. Constructors initialize every field, including optional HTTP handles, IDs, query strings, and queues.
5. Await `adapter.open()` under a fixed 10-second total startup timeout. It returns the public Session ID.
6. Construct Session buffers from adapter media limits and let ClientChannel adopt the ID. Send `session.started` with the validated Config.
7. Only after that write succeeds, start receiver, feeder, and forwarder tasks.

ClientChannel bounds each ordinary write, including lock acquisition and `session.started`, to five seconds. A failed acknowledgement is a startup failure. The retained adapter is cleanup-owned from step 4 onward.

A disconnect during open may be recognized when open completes or its timeout expires. Clients wait for `session.started` before sending Feed.

### 5.3 Running tasks and coordinator

After acknowledgement there are **three owned worker tasks** (receiver, feeder, forwarder), plus the coordinator waiting on them. JoyAI and Mock spawn no private reader tasks.

The coordinator uses `asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)`. Once any worker finishes:

1. Inspect every completed outcome. A normal receiver completion means the Client disconnected; a feeder/forwarder completion or worker exception is terminal.
2. Cancel every remaining task and gather all task outcomes with `return_exceptions=True`.
3. Inspect the gathered outcomes as well, log every unexpected failure, and retain one useful terminal message.

The receiver processes Feed and sends a recoverable Error for a second Start. The forwarder sends each item from `adapter.read_replies()` immediately. Iterator EOF is a fatal `"Model reply stream ended"` failure.

Receiver, feeder, and forwarder report outcomes to the coordinator; only the coordinator closes the socket.

### 5.4 Ingest and feeder

Ingest handles Frame, Audio, then Text. After each successful accepted media push it sets `session.feed_ready`; this keeps any valid prefix actionable even if a later field fails. Text is offered synchronously to the adapter before ingest returns. Text alone does not set the event in either v1 adapter.

`feed_ready` is a plain `asyncio.Event`, used as a notification rather than a turn counter. The feeder clears it before consuming and drains all ready work:

```python
async def feed_model(session, channel):
    while True:
        await session.feed_ready.wait()
        session.feed_ready.clear()
        while True:
            try:
                progressed = await session.adapter.send_feed(
                    session.frames, session.audio
                )
            except SessionError as exc:
                if exc.fatal:
                    raise
                # Recoverable turn failure means its media was already consumed.
                await channel.send_error(exc.message, fatal=False)
                continue
            if not progressed:
                break
```

`send_feed` returns true after consuming/attempting one eligible media unit, and false immediately when no complete work is ready. It consumes media and snapshots Text before its first await. A recoverable turn error must also have consumed its media; never retry that same slice in this loop.

This handles multiple complete Audio slices represented by one event and input arriving during a slow turn. A push during a turn may leave the event set after draining; the next outer iteration performs one harmless empty check. Feeding is event-driven and serial.

### 5.5 One cleanup path

The outer `finally` runs for open errors, acknowledgement failures, worker failures, normal disconnect, and cancellation:

1. Cancel/gather owned tasks, even if startup never reached task creation.
2. Close any retained adapter, including partially opened ones. JoyAI bounds its best-effort reset to two seconds and closes its HTTP client in a `finally` (§8). Log cleanup failures without replacing the primary failure.
3. After producers have stopped, attempt a terminal Error if one exists and the Client may still be writable. Bound this attempt to two seconds.
4. Attempt socket close in a separate `finally`, also bounded to two seconds; it must still run if error delivery fails. Drop Session buffers and references.

Use close code 1000 for normal termination and 1011 for a terminal server/session failure. Ordinary Client disconnect produces no Error. Preserve `CancelledError` after cleanup.

Error delivery is best-effort. Cleanup runs independently of send, lock, or peer-acknowledgement outcomes. Gateway task cancellation does not cancel an upstream GPU generation that webinfer has already started.

## 6. Media buffers and Text semantics

### 6.1 Frame Buffer

A deque retains at most `max_frames_per_request` Frames, dropping the oldest on overflow. Each Frame is `VideoFrame(jpeg: bytes, t: float)`.

`consume()` returns all retained Frames in arrival/capture order and clears the deque. An empty result means no work; one Frame is enough even if the maximum is eight. A maximum of one retains the newest Frame. An in-flight batch belongs to the adapter and is no longer buffered.

### 6.2 Audio Buffer

Retain a bounded rolling sequence of complete PCM samples. Capacity and request slice size are separate explicit adapter values:

| Adapter | Frame maximum           | Audio slice  | Audio retention |
| ------- | ----------------------- | ------------ | --------------- |
| JoyAI   | Config value, default 1 | 0 (disabled) | 0               |
| Mock    | 4                       | 0.2 seconds  | 1.0 second      |

At 16 kHz s16le mono, Mock consumes 6,400 bytes per slice and retains at most 32,000 bytes. Incoming overflow drops the oldest complete samples.

`consume()` returns exactly one full slice, leaving the remainder; otherwise it returns null/None. None covers both empty and incomplete buffers. Disabled Audio is identified separately by a zero slice size. Incomplete Audio does not prevent Mock from consuming Frames.

Validate even incoming byte lengths and compute all capacities and slices in whole samples. Overflow deletion preserves sample alignment. Buffer methods never await. A partial slice waits for more input and is discarded on Session close.

Retained Audio is sample-ordered, but overflow can create gaps. Frame and Audio buffering are independent.

### 6.3 Text

For JoyAI and Mock, `offer_text` stores the latest non-empty stripped Text in adapter state; empty or whitespace-only Text leaves it unchanged.

- JoyAI applies that Text to the next visual HTTP turn.
- Mock includes it in the next media-triggered simulated turn.
- Text alone never initiates either turn. If media is already in flight, newly received Text affects a later turn.
- Each adapter snapshots its Text before awaiting network I/O or simulated latency, so a later Feed cannot change the meaning of a turn already started.

Ending the Session clears remembered Text.

## 7. Adapter contract

Use this typed base interface:

```python
class Adapter[ConfigT: BaseModel](ABC):
    config_model: ClassVar[type[BaseModel]]

    # Constructor: retain spec; validate raw Config once; no external resources.
    # Expose max_frames_per_request, audio_seconds_per_request,
    # and audio_retention_seconds as concrete attributes/properties.

    @abstractmethod
    async def open(self) -> str: ...

    @abstractmethod
    def offer_text(self, text: str) -> None: ...

    @abstractmethod
    async def send_feed(self, frames: FrameBuffer, audio: AudioBuffer) -> bool: ...

    @abstractmethod
    def read_replies(self) -> AsyncIterator[Reply]: ...

    @abstractmethod
    async def close(self) -> None: ...
```

The common constructor validates with `self.config_model.model_validate(raw_config)` and uses one localized cast to `ConfigT`. Concrete classes supply their Config class and initialize their own state. The heterogeneous registry typing remains local to Catalog.

JoyAI and Mock each own a bounded `asyncio.Queue[Reply]` of 64 entries. Their `read_replies` async generators yield queue items, and `send_feed` awaits queue puts.

The queue bounds locally retained Replies and can delay later JoyAI/Mock turns. Preserve every chunk of a partially delivered Reply turn. Teardown cancels the generator; these adapters do not use a queue sentinel.

Session IDs follow ADR 0017: `{catalog-id}-{uuid-hex}` in kebab-case. Both adapters mint the ID during `open()`; JoyAI uses the full ID in `x-streaming-session`. Catalog IDs are at most 64 characters, keeping the result within webinfer's 120-character limit.

Session depends only on the adapter methods above. A direct upstream async iterator is a valid `read_replies()` implementation; EOF and exceptions propagate to Session. A test adapter verifies that the forwarder can deliver a Reply while `send_feed()` remains blocked.

## 8. JoyAI adapter

### 8.1 Source contract

Implement against the checked-in [webinfer source](../../JoyAI-VL-Interaction/services/webinfer/live_adapter.py). Relevant contract points:

| Behavior                                                         | Local source                                                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Reset parses JSON and returns success even for a missing Session | [reset handler](../../JoyAI-VL-Interaction/services/webinfer/live_adapter.py#L773)          |
| Prompt-key header and image-dependent request path               | [request handling](../../JoyAI-VL-Interaction/services/webinfer/live_adapter.py#L1086)      |
| Forced silence can have empty Raw                                | [forced silence](../../JoyAI-VL-Interaction/services/webinfer/live_adapter.py#L1221)        |
| Latest non-empty query persists                                  | [query update](../../JoyAI-VL-Interaction/services/webinfer/live_adapter.py#L1454)          |
| Inbound generation settings are conditional, ignored by default  | [generation parameters](../../JoyAI-VL-Interaction/services/webinfer/live_adapter.py#L1636) |
| Normalized content and original Raw are separate fields          | [response builder](../../JoyAI-VL-Interaction/services/webinfer/live_adapter.py#L2244)      |

Phase 6 verifies that the deployed version matches these contract points.

### 8.2 Open and close

Initialize `_http = None`, `session_id = ""`, `_query = ""`, and the Reply queue in the constructor.

During open, mint the public Session ID, create and retain the HTTPX client using `spec.base_url`, and POST `/streaming/reset` with header `x-streaming-session` and `json={}`. Require a successful status. The normal response for a previously absent Session is 200 with `removed: false`; treat any 404 as a binding failure.

The base URL includes `/v1`; the resolved endpoint is `/v1/streaming/reset`. A successful reset confirms webinfer route availability only. Phase 6 separately verifies an inference turn.

During close, attempt the same reset if an HTTP client and ID exist, under a two-second total timeout. Always close the HTTPX client in a `finally`, including when reset raises or is cancelled. Make close idempotent and safe after partial open by clearing the retained handle. Log reset failures after releasing the client.

### 8.3 A visual turn

`send_feed` synchronously consumes the current Frame batch. If empty, return false. Snapshot `_query` before awaiting anything; Audio is unused.

POST to the resolved `/v1/chat/completions` with:

- `x-streaming-session: <public-session-id>`;
- `x-system-prompt-key: <validated Config key>`;
- `model: "JoyAI-VL-Interaction"`, defined as an adapter constant;
- one user message containing the snapshotted Text, if nonempty, and each JPEG as an OpenAI-style `image_url` data URL;
- one matching `frame_time_ranges` entry per Frame, formatted as `"<session-relative seconds to one decimal> seconds"`. Convert playground Unix-ms `t` to seconds from adapter open at this boundary (`(t - origin_unix_ms) / 1000`).

The request contains only the fields listed above. JoyAI performs the upstream JPEG data-URL encoding.

Use a fixed 60-second total timeout for a visual turn and make one attempt. HTTP failures, timeouts, and responses missing the required content fields become recoverable `SessionError`s after the batch has been consumed. Send one Error and continue with newer buffered media. Unexpected programming errors are fatal.

Successful calls put one Reply on the adapter queue and return true. The feeder serializes HTTP requests and response parsing.

### 8.4 Presentable Text versus Raw

Use `choices[0].message.content` for presentable content and `streamingharness.raw_content` for Raw. Preserve Raw exactly, including whitespace and an empty string.

Normalize the content field by trimming surrounding whitespace. Map `</silence>` to empty presentable Text. Otherwise remove a leading `</response>` and remove `</delegation>` / `<delegation>` display markers while retaining their associated text. This normalization is display-only. Missing or malformed required fields fail the turn.

| Upstream content        | Upstream Raw                  | Reply Text  | Reply Raw                   |
| ----------------------- | ----------------------------- | ----------- | --------------------------- |
| `</response> A laptop.` | `  </response> A laptop.  `   | `A laptop.` | `  </response> A laptop.  ` |
| `</silence>`            | `</silence>`                  | empty       | `</silence>`                |
| `</silence>`            | empty string (forced silence) | empty       | empty string                |

Each successful JoyAI HTTP turn produces one Reply with `audio=None` and `final=True`, including silence. A failed turn produces an Error.

## 9. Mock adapter

Mock opens without network access and has no external resource to release.

For each `send_feed`:

1. Consume the current Frame batch and at most one complete Audio slice. Preserve incomplete Audio.
2. If neither is available, return false. Text alone is not work.
3. Snapshot Text and the consumed Frame count / Audio byte count before the first await.
4. Wait `latency_ms / 1000`.
5. Emit two deterministic Reply chunks describing that snapshot. Each carries 0.1 seconds of silent 24 kHz s16le mono Audio (4,800 bytes). Split the presentable sentence across the two Text chunks; use each chunk's unnormalized mock text as its Raw.
6. Set `final=False` then `final=True`, and return true.

Audio-only and Frame-only turns both work. The feeder immediately attempts another turn when a complete Audio slice remains. Tests use a test adapter for injected failures.

## 10. Local operation and JoyAI access

The gateway binds to `127.0.0.1:8787` by default. Catalog discovery and Mock Sessions work without a cluster connection. The README includes environment setup, install/run/test commands, and copyable Mock and JoyAI client examples.

The [PBS launcher](../scripts/joyai.pbs) uses these separate ports:

| Service | Default port | Role |
| --- | --- | --- |
| Gateway | 8787 | Client HTTP and WebSocket API |
| webinfer | 8070 | JoyAI Session and visual-turn HTTP API |
| vLLM | 7060 | Model inference used by webinfer |

The JoyAI Catalog `base_url` must address webinfer and end in `/v1`. When webinfer is bound to compute-node loopback, establish the lab-approved forward to the actual job node and set `base_url` to the forwarded local address. Phase 6 records the verified access command and deployment identifier in the README. Model launching, listener changes, and access-policy changes are outside this server implementation.

## 11. Error policy

Use `SessionError(message, fatal=True)` for deliberate application failures. Error messages sent to the Client contain `session_id`, `fatal`, and `message`.

| Situation                                                    | Behavior                                             |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| Malformed JSON, unknown type, binary frame, invalid envelope | Recoverable Error; continue                          |
| Feed before Start                                            | Recoverable Error; do not buffer                     |
| Unknown Model / invalid Config on first Start                | Fatal Error; cleanup and close                       |
| Open/acknowledgement failure or startup timeout              | Fatal; cleanup, best-effort Error and close          |
| Second Start                                                 | Recoverable Error; retain current Session and Config |
| Invalid accepted media                                       | Recoverable Error; any earlier valid field remains buffered |
| Unsupported modality                                         | Quiet-drop; no Error                                 |
| One failed JoyAI HTTP turn                                   | Recoverable Error; consumed media is not retried     |
| Reply iterator EOF/failure or unexpected worker exception    | Fatal; cancel siblings and clean up                  |
| Ordinary Client disconnect                                   | Normal cleanup without an Error                      |
| Error write/close failure                                    | Log as appropriate; still run independent cleanup    |

A failed recoverable Error write terminates its worker and triggers coordinator cleanup. Cancellation propagates after cleanup.

## 12. Verification and implementation phases

### 12.1 Implementation phases and review gates

Implement the phases in order. Each phase is a focused change set that passes its own tests and all tests introduced earlier. Stop after each phase for the user's review and approval unless the user explicitly requests multiple phases together.

At each handoff, provide the changed-file list, concise diff summary, exact verification commands and results, a small reproducible example or test, and remaining limitations or review comments. Resolve review comments before progressing. Keep README instructions aligned with the implemented checkpoint.

| Phase                                | Reviewable outcome                                               | Main review question                                               |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1. Core contracts and media          | Tested wire types, codecs, and buffers                           | Are the payload and retention rules right?                         |
| 2. Adapter boundary and Mock         | Mock runs through the adapter interface without a server         | Is the model boundary small and understandable?                    |
| 3. Catalog and HTTP discovery        | A runnable gateway lists the implemented Mock                    | Is discovery/configuration independent of Session and network I/O? |
| 4. WebSocket Session with Mock       | Complete offline Client → Session → Mock → Reply path            | Are scheduling, errors, and resource ownership correct?            |
| 5. JoyAI integration, offline-tested | Both adapters available; JoyAI verified with fake HTTP transport | Does the adapter faithfully map the webinfer contract?             |
| 6. Live verification and handoff     | Deployed JoyAI smoke and final v1 acceptance evidence            | Does the tested design work against the actual deployment?         |

#### Phase 1 — Core contracts and media primitives

**Scope:** Bootstrap the Python package and test/type-check setup. Implement `ModelSpec`, `VideoFrame`, `Reply`, `SessionError`, and the Session ID helper in `types.py`; wire models in `protocol.py`; and codecs and synchronous buffers in `codecs.py` / `buffers.py` (§2, §4, §6). This phase contains no adapters or network routes.

**Verification:** Test Start/Feed parsing and the single validation path; base64/JPEG/PCM checks; sample alignment; newest-Frame retention and immediate partial-batch eligibility; complete Audio slices, overflow, and remainder retention. Check that the shared modules import without application-layer dependencies. Session-dependent timing, quiet-drop, and outbound ID behavior are verified in their later owning phases.

**Review gate:** The package installs, tests and type checks pass, and focused tests show exactly which Frames and samples survive a burst.

#### Phase 2 — Adapter boundary and standalone Mock

**Depends on:** Approved Phase 1.

**Scope:** Implement the typed adapter interface and Mock, including `MockConfig`, open/close, adapter-local Text state, bounded Reply queue, and two-chunk output (§7, §9). Exercise the adapter directly in tests. Network routes remain outside this phase.

**Verification:** Test Config defaults and unknown-key rejection, Model-prefixed IDs, the bounded Reply queue, Frame-only and Audio-only work, incomplete Audio preservation, Text-only no-op, Text snapshotting across a blocked turn, deterministic PCM lengths, and the two chunks' Raw/final semantics. Use controlled scheduling and verify that Mock performs no network I/O.

**Review gate:** A focused test demonstrates open → supply media → feed → read two Replies → close. The base interface has no transport or Reply-queue implementation.

#### Phase 3 — Catalog and HTTP discovery

**Depends on:** Approved Phase 2.

**Scope:** Implement Catalog loading from `config.toml`, the explicit adapter registry, gateway bind environment/default resolution, and the three HTTP routes in `catalog.py` / `main.py` (§3). At this checkpoint, the registry and `[[models]]` contain **Mock only**. Generate its schema from `MockConfig`. Add gateway install/run instructions to README.

**Verification:** Test missing config files, malformed TOML, duplicate/invalid IDs, unknown adapters, schema/default consistency, list/detail/404 responses, and process health. Test `LIVE_VLM_CONFIG`, bind defaults, invalid ports, and bind overrides at the run-entry-point boundary. Verify that HTTP discovery constructs no adapter and performs no network I/O.

**Review gate:** Run the gateway locally and inspect `/health`, `/v1/models`, and `/v1/models/mock`. The returned Model has exactly `id`, `label`, and `config_schema`.

#### Phase 4 — WebSocket Session and end-to-end Mock

**Depends on:** Approved Phase 3.

**Scope:** Implement ClientChannel, Session, the coordinator, receiver, feeder, and forwarder; expose `/v1/realtime` (§4–§6, §11). Wire Mock through that path and add a minimal runnable Client example. Implement shutdown and failure handling in the same phase.

**Verification:** Test acknowledged Start, effective Config, Feed/Reply encoding and IDs, protocol validation Errors, repeated/invalid Start, accepted-field errors with an earlier valid field retained, both timestamp modes, Text timing, and normal close. Cover serialized concurrent Reply/Error writes, write timeouts, one-notification Audio draining, input during a blocked turn, recoverable turn failures, and idle waiting. Use test adapters and controlled events for partial open, startup timeout/cancellation, failed acknowledgement, worker failures, simultaneous outcomes, Reply EOF, and failed Error delivery. Verify close codes, cancellation/gather, and adapter close ownership. Deliver a Reply while feeding remains blocked (§7).

**Review gate:** Run the complete Mock WebSocket demo. All Session, scheduling, and test-adapter cleanup checks pass.

#### Phase 5 — JoyAI integration with offline contract tests

**Depends on:** Approved Phase 4.

**Scope:** Implement `JoyAIConfig` and `JoyAIAdapter` against §8. Add JoyAI to the registry and Catalog. Add JoyAI `base_url` validation and define the webinfer model name as an adapter constant. Extend README with JoyAI configuration and usage. Use fake HTTP transports for automated integration tests.

**Verification:** Check resolved `/v1` URLs, reset `json={}`, stable Session headers, prompt key, Frame/time pairs, the `JoyAI-VL-Interaction` model constant, latest-nonempty-Text snapshots, and the exact request field set. Test normal, delegation-marker, silent, forced-silent, and malformed responses; exact Raw preservation; and single-attempt recoverable HTTP failures/timeouts. Run JoyAI through the Session coordinator, including quiet-dropped Audio and partial-open/failed-reset cleanup that closes the HTTP client. Run the cumulative suite and type checks for both adapters.

**Review gate:** Trace a JoyAI Feed through captured fake-transport requests and responses to its normalized Reply. Catalog discovery and Mock remain fully offline. Record live deployment verification as pending.

#### Phase 6 — Live JoyAI verification and final handoff

**Depends on:** Approved Phase 5 and availability of the user's deployed JoyAI endpoint and supported access route.

**Scope:** Follow §10 to identify the job node, establish the permitted access route, record the deployed contract/model identifier, and run one real visual turn. Check Start/reset, presentable versus Raw output, and Session close/cleanup. Re-run the Mock demo and cumulative tests/type checks. Finish reproducible setup/run/test/smoke instructions and record the results against §12.2. Model deployment and listener/access-policy changes remain outside scope.

**Verification:** Record the deployment identifier, exact commands, observed results, and any unverified acceptance items. Verify both reset route availability and successful inference. If the endpoint or route is unavailable, report the operational blocker and leave this phase pending.

**Review gate:** Review the final acceptance evidence and any regression-tested fixes exposed by the smoke. Mark v1 complete after the required live and offline checks pass.

### 12.2 Acceptance

V1 is complete when:

- Catalog discovery and a full Mock Session work offline.
- JoyAI Start/reset, visual turn, presentable/Raw output, and cleanup work against the deployed webinfer endpoint.
- Invalid/repeated Start and bad Feed behavior match §11.
- Burst/slow-turn tests prove bounded retention, draining, and Text snapshot semantics.
- All startup and worker failure paths release owned resources even if the Client cannot receive an Error.
- Adapters remain independent of the Client socket, and the test-only concurrent-output adapter passes.

Out of scope: MiniCPM integration, frontend implementation, model serving/deployment changes, authentication, persistence and transcripts, presets, Clear/Interrupt, live Config changes, binary/WebRTC transport, A/V synchronization, automatic retries, reconnect/resume, and production hardening.

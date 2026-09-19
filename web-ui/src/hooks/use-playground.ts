"use client";

import { fetchCatalog, type CatalogModel } from "@/lib/catalog";
import {
  captureJpegBase64,
  DEFAULT_FRAMES_PER_SECOND,
  clampFramesPerSecond,
  frameIntervalMs,
  waitForVideoFrame,
} from "@/lib/capture";
import { DEFAULT_GATEWAY_ADDRESS, getRealtimeUrl, parseGatewayAddress } from "@/lib/gateway";
import { defaultsFromSchema } from "@/lib/json-schema";
import { encodePcmBase64, PcmCapture, PcmPlayer } from "@/lib/pcm";
import { encodeClientMessage, parseServerMessage } from "@/lib/protocol";
import { useEffect, useRef, useState, type RefObject } from "react";

export type CameraViewState = "empty" | "permission" | "connecting" | "live" | "error";

export type SessionPhase = "idle" | "connecting" | "live";

export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  streaming: boolean;
};

export type DebugRawEntry = {
  id: string;
  raw: string;
  streaming: boolean;
  /** Logged send timestamp for this turn, Unix milliseconds. */
  t: number;
};

export type PlaygroundState = {
  catalogStatus: "loading" | "ready" | "error";
  catalogError: string | null;
  models: CatalogModel[];
  selectedModelId: string;
  config: Record<string, unknown>;
  serverAddress: string;
  framesPerSecond: number;
  selectedModel: CatalogModel | undefined;
  phase: SessionPhase;
  sessionId: string | null;
  recoverableError: string | null;
  fatalError: string | null;
  cameraError: string | null;
  cameraView: CameraViewState;
  previewStream: MediaStream | null;
  cameraOn: boolean;
  micOn: boolean;
  micError: string | null;
  messages: TranscriptMessage[];
  debugEntries: DebugRawEntry[];
  isStreaming: boolean;
  sessionActive: boolean;
  canStart: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  setSelectedModelId: (id: string) => void;
  setConfigValue: (key: string, value: unknown) => void;
  setServerAddress: (value: string) => void;
  commitServerAddress: () => void;
  setFramesPerSecond: (value: number) => void;
  reloadCatalog: () => void;
  start: () => Promise<void>;
  stop: () => void;
  sendText: (text: string) => Promise<void>;
  toggleCamera: () => void;
  toggleMicrophone: () => void;
};

const CAMERA_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "user",
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

const SESSION_END_ACK_TIMEOUT_MS = 8_000;

type SessionEndWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

function hasPresentableText(text: string): boolean {
  return text.trim().length > 0;
}

function hasRawOutput(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.length > 0;
}

function deviceCopy(device: "camera" | "microphone"): { noun: string; label: string } {
  switch (device) {
    case "camera":
      return { noun: "camera", label: "Camera" };
    case "microphone":
      return { noun: "microphone", label: "Microphone" };
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

function mediaDeviceErrorMessage(error: unknown, device: "camera" | "microphone"): string {
  const { noun, label } = deviceCopy(device);
  if (!(error instanceof Error)) {
    return `${label} access failed`;
  }
  if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
    return `${label} permission was denied`;
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return `No ${noun} was found`;
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return `The ${noun} is already in use`;
  }
  if (error.name === "SecurityError") {
    return `${label} access requires a secure browser context`;
  }
  return error.message || `${label} access failed`;
}

function stopMediaStream(stream: MediaStream | null) {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export function usePlayground(initialModels: CatalogModel[], initialCatalogError: string | null): PlaygroundState {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const pcmCaptureRef = useRef<PcmCapture | null>(null);
  const pcmPlayerRef = useRef<PcmPlayer | null>(null);
  const frameTimerRef = useRef<number | null>(null);
  const lastSentTRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const cameraRequestIdRef = useRef(0);
  const micRequestIdRef = useRef(0);
  const captureTailRef = useRef(Promise.resolve());
  const liveRef = useRef(false);
  const cameraLiveRef = useRef(false);
  const cameraInFlightRef = useRef(false);
  const micInFlightRef = useRef(false);
  const streamingAssistantIdRef = useRef<string | null>(null);
  const streamingDebugIdRef = useRef<string | null>(null);
  const stoppingRef = useRef(false);
  const endingRef = useRef<SessionEndWaiter | null>(null);

  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "error">(
    initialCatalogError ? "error" : initialModels.length > 0 ? "ready" : "error"
  );
  const [catalogError, setCatalogError] = useState<string | null>(
    initialCatalogError ?? (initialModels.length > 0 ? null : "Catalog did not return any models")
  );
  const [models, setModels] = useState<CatalogModel[]>(initialModels);
  const [selectedModelId, setSelectedModelIdState] = useState(initialModels[0]?.id ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(() =>
    initialModels[0] ? defaultsFromSchema(initialModels[0].config_schema) : {}
  );
  const [serverAddress, setServerAddressState] = useState(DEFAULT_GATEWAY_ADDRESS);
  const [framesPerSecond, setFramesPerSecondState] = useState(DEFAULT_FRAMES_PER_SECOND);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recoverableError, setRecoverableError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraView, setCameraView] = useState<CameraViewState>("empty");
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [debugEntries, setDebugEntries] = useState<DebugRawEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const selectedModel = models.find((model) => model.id === selectedModelId);
  const serverAddressRef = useRef(serverAddress);
  const selectedModelIdRef = useRef(selectedModelId);
  const selectedModelRef = useRef(selectedModel);
  const configRef = useRef(config);
  const framesPerSecondRef = useRef(framesPerSecond);
  const fetchedOriginRef = useRef(parseGatewayAddress(DEFAULT_GATEWAY_ADDRESS));
  serverAddressRef.current = serverAddress;
  selectedModelIdRef.current = selectedModelId;
  selectedModelRef.current = selectedModel;
  configRef.current = config;
  framesPerSecondRef.current = framesPerSecond;

  function applyModel(model: CatalogModel) {
    const nextConfig = defaultsFromSchema(model.config_schema);
    setSelectedModelIdState(model.id);
    setConfig(nextConfig);
    selectedModelIdRef.current = model.id;
    selectedModelRef.current = model;
    configRef.current = nextConfig;
  }

  async function loadCatalog() {
    setCatalogStatus("loading");
    setCatalogError(null);
    try {
      const address = serverAddressRef.current;
      const nextModels = await fetchCatalog(address);
      setModels(nextModels);
      setCatalogStatus("ready");
      const current = nextModels.find((model) => model.id === selectedModelIdRef.current);
      applyModel(current ?? nextModels[0]);
      fetchedOriginRef.current = parseGatewayAddress(address);
    } catch (error) {
      setCatalogStatus("error");
      setCatalogError(error instanceof Error ? error.message : "Unable to load the model Catalog");
    }
  }

  function commitServerAddress() {
    if (phase !== "idle") {
      return;
    }
    const origin = parseGatewayAddress(serverAddressRef.current);
    if (origin === fetchedOriginRef.current) {
      return;
    }
    void loadCatalog();
  }

  function stopVideoPreview() {
    cameraLiveRef.current = false;
    const stream = videoStreamRef.current;
    videoStreamRef.current = null;
    setPreviewStream(null);
    stopMediaStream(stream);
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }

  function stopMicrophoneTracks() {
    stopPcmCapture();
    const stream = audioStreamRef.current;
    audioStreamRef.current = null;
    stopMediaStream(stream);
  }

  function stopPcmCapture() {
    pcmCaptureRef.current?.stop();
    pcmCaptureRef.current = null;
  }

  function stopPcmPlayer() {
    pcmPlayerRef.current?.close();
    pcmPlayerRef.current = null;
  }

  function ensurePcmPlayer(): PcmPlayer {
    if (!pcmPlayerRef.current) {
      pcmPlayerRef.current = new PcmPlayer();
    }
    return pcmPlayerRef.current;
  }

  function sendAudio(pcm: Uint8Array) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !liveRef.current) {
      return;
    }
    if (pcm.byteLength < 2) {
      return;
    }
    socket.send(
      encodeClientMessage({
        type: "input.append",
        audio: encodePcmBase64(pcm),
        t: Date.now(),
      })
    );
  }

  async function attachPcmCapture(stream: MediaStream) {
    const capture = new PcmCapture(stream, sendAudio);
    pcmCaptureRef.current = capture;
    try {
      await capture.start();
      if (pcmCaptureRef.current !== capture) {
        capture.stop();
      }
    } catch (error) {
      if (pcmCaptureRef.current !== capture) {
        return;
      }
      pcmCaptureRef.current = null;
      capture.stop();
      setMicError(mediaDeviceErrorMessage(error, "microphone"));
    }
  }

  function syncPcmCapture() {
    const stream = audioStreamRef.current;
    if (liveRef.current && stream) {
      if (pcmCaptureRef.current) {
        return;
      }
      void attachPcmCapture(stream);
      return;
    }
    stopPcmCapture();
  }

  function playReplyAudio(audio: string) {
    const player = ensurePcmPlayer();
    player.enqueue(audio);
    void player.resume();
  }

  function stopFrameTimer() {
    if (frameTimerRef.current !== null) {
      window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
  }

  function closeSocket() {
    const socket = socketRef.current;
    socketRef.current = null;
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  function resetTransientState() {
    liveRef.current = false;
    lastSentTRef.current = null;
    streamingAssistantIdRef.current = null;
    streamingDebugIdRef.current = null;
    setIsStreaming(false);
    setSessionId(null);
    setPhase("idle");
    setMessages([]);
    setDebugEntries([]);
  }

  function cleanupSession() {
    stopFrameTimer();
    closeSocket();
    stopPcmCapture();
    stopPcmPlayer();
    resetTransientState();
  }

  function captureFrame(): string | null {
    const video = videoRef.current;
    if (!video) {
      return null;
    }
    if (!canvasRef.current) {
      canvasRef.current = document.createElement("canvas");
    }
    return captureJpegBase64(video, canvasRef.current);
  }

  function enqueueCapture(task: () => Promise<void>) {
    const run = captureTailRef.current.then(task, task);
    captureTailRef.current = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function sendFeed(frame: string, text?: string) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !liveRef.current) {
      return false;
    }
    // Playground protocol `t` is absolute Unix time in milliseconds.
    const t = Date.now();
    lastSentTRef.current = t;
    socket.send(
      encodeClientMessage({
        type: "input.append",
        frame,
        ...(text !== undefined ? { text } : {}),
        t,
      })
    );
    return true;
  }

  function sendLiveFrame() {
    if (!liveRef.current || !cameraLiveRef.current) {
      return;
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const frame = captureFrame();
    if (!frame) {
      return;
    }
    sendFeed(frame);
  }

  function startFrameLoop() {
    stopFrameTimer();
    frameTimerRef.current = window.setInterval(() => {
      void enqueueCapture(async () => {
        sendLiveFrame();
      });
    }, frameIntervalMs(framesPerSecondRef.current));
  }

  function applyFramesPerSecond(value: number) {
    const next = clampFramesPerSecond(value);
    if (next === framesPerSecondRef.current) {
      return;
    }
    framesPerSecondRef.current = next;
    setFramesPerSecondState(next);
    if (liveRef.current) {
      startFrameLoop();
    }
  }

  function handleServerPayload(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setRecoverableError("Received malformed JSON from the gateway");
      return;
    }

    const message = parseServerMessage(parsed);
    if (!message) {
      return;
    }

    if (message.type === "session.ended") {
      endingRef.current?.resolve();
      return;
    }

    if (stoppingRef.current) {
      return;
    }

    switch (message.type) {
      case "session.started":
        liveRef.current = true;
        setSessionId(message.session_id);
        setPhase("live");
        setFatalError(null);
        setRecoverableError(null);
        startFrameLoop();
        syncPcmCapture();
        void ensurePcmPlayer().resume();
        break;
      case "response.chunk": {
        if (message.audio) {
          playReplyAudio(message.audio);
        }
        const chunk = message.text ?? "";
        const presentable = hasPresentableText(chunk);
        const rawChunk = message.raw ?? "";
        const presentableRaw = hasRawOutput(rawChunk);

        if (presentable) {
          const streamingId = streamingAssistantIdRef.current;
          if (streamingId) {
            setMessages((current) =>
              current.map((entry) =>
                entry.id === streamingId
                  ? {
                      ...entry,
                      text: `${entry.text}${chunk}`,
                      streaming: !message.final,
                    }
                  : entry
              )
            );
          } else {
            const id = crypto.randomUUID();
            if (!message.final) {
              streamingAssistantIdRef.current = id;
            }
            setMessages((current) => [
              ...current,
              {
                id,
                role: "assistant",
                text: chunk,
                streaming: !message.final,
              },
            ]);
          }
        } else if (streamingAssistantIdRef.current && message.final) {
          const streamingId = streamingAssistantIdRef.current;
          setMessages((current) =>
            current.map((entry) => (entry.id === streamingId ? { ...entry, streaming: false } : entry))
          );
        }

        if (message.final) {
          streamingAssistantIdRef.current = null;
        }

        if (presentableRaw) {
          const streamingId = streamingDebugIdRef.current;
          if (streamingId) {
            setDebugEntries((current) =>
              current.map((entry) =>
                entry.id === streamingId
                  ? {
                      ...entry,
                      raw: `${entry.raw}${rawChunk}`,
                      streaming: !message.final,
                    }
                  : entry
              )
            );
          } else {
            const id = crypto.randomUUID();
            if (!message.final) {
              streamingDebugIdRef.current = id;
            }
            setDebugEntries((current) => [
              ...current,
              {
                id,
                raw: rawChunk,
                streaming: !message.final,
                t: message.t ?? lastSentTRef.current ?? Date.now(),
              },
            ]);
          }
        } else if (streamingDebugIdRef.current && message.final) {
          const streamingId = streamingDebugIdRef.current;
          setDebugEntries((current) =>
            current.map((entry) => (entry.id === streamingId ? { ...entry, streaming: false } : entry))
          );
        }

        if (message.final) {
          streamingDebugIdRef.current = null;
        }

        setIsStreaming(!message.final);
        break;
      }
      case "error":
        if (message.fatal) {
          setFatalError(message.message);
          setRecoverableError(null);
          setIsStreaming(false);
          cleanupSession();
        } else {
          setRecoverableError(message.message);
        }
        break;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  }

  function disableCamera() {
    cameraRequestIdRef.current += 1;
    cameraInFlightRef.current = false;
    stopVideoPreview();
    setCameraOn(false);
    setCameraError(null);
    setCameraView("empty");
  }

  async function enableCamera() {
    const requestId = cameraRequestIdRef.current + 1;
    cameraRequestIdRef.current = requestId;
    cameraInFlightRef.current = true;
    setCameraError(null);
    setCameraView("permission");
    try {
      if (!window.isSecureContext) {
        throw new DOMException("Camera access requires a secure browser context", "SecurityError");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: CAMERA_VIDEO_CONSTRAINTS,
      });
      if (requestId !== cameraRequestIdRef.current) {
        stopMediaStream(stream);
        return;
      }
      setCameraView("connecting");
      videoStreamRef.current = stream;
      setPreviewStream(stream);
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        await waitForVideoFrame(video);
      }
      if (requestId !== cameraRequestIdRef.current) {
        stopVideoPreview();
        return;
      }
      cameraLiveRef.current = true;
      cameraInFlightRef.current = false;
      setCameraOn(true);
      setCameraView("live");
      if (liveRef.current) {
        void enqueueCapture(async () => {
          sendLiveFrame();
        });
      }
    } catch (error) {
      if (requestId !== cameraRequestIdRef.current) {
        return;
      }
      cameraInFlightRef.current = false;
      stopVideoPreview();
      setCameraOn(false);
      const message = mediaDeviceErrorMessage(error, "camera");
      setCameraError(message);
      setCameraView(message.toLowerCase().includes("permission") ? "permission" : "error");
    }
  }

  function toggleCamera() {
    if (cameraLiveRef.current || cameraInFlightRef.current) {
      disableCamera();
      return;
    }
    void enableCamera();
  }

  function disableMicrophone() {
    micRequestIdRef.current += 1;
    micInFlightRef.current = false;
    stopMicrophoneTracks();
    setMicOn(false);
    setMicError(null);
  }

  async function enableMicrophone() {
    const requestId = micRequestIdRef.current + 1;
    micRequestIdRef.current = requestId;
    micInFlightRef.current = true;
    setMicError(null);
    try {
      if (!window.isSecureContext) {
        throw new DOMException("Microphone access requires a secure browser context", "SecurityError");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (requestId !== micRequestIdRef.current) {
        stopMediaStream(stream);
        return;
      }
      audioStreamRef.current = stream;
      micInFlightRef.current = false;
      setMicOn(true);
      syncPcmCapture();
      void pcmPlayerRef.current?.resume();
    } catch (error) {
      if (requestId !== micRequestIdRef.current) {
        return;
      }
      micInFlightRef.current = false;
      stopMicrophoneTracks();
      setMicOn(false);
      setMicError(mediaDeviceErrorMessage(error, "microphone"));
    }
  }

  function toggleMicrophone() {
    if (audioStreamRef.current || micInFlightRef.current) {
      disableMicrophone();
      return;
    }
    void enableMicrophone();
  }

  async function start() {
    if (phase !== "idle") {
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setFatalError(null);
    setRecoverableError(null);
    setMessages([]);
    setDebugEntries([]);
    setIsStreaming(false);
    setPhase("connecting");

    if (parseGatewayAddress(serverAddressRef.current) !== fetchedOriginRef.current) {
      await loadCatalog();
    }
    if (generation !== generationRef.current) {
      return;
    }
    if (parseGatewayAddress(serverAddressRef.current) !== fetchedOriginRef.current) {
      setPhase("idle");
      return;
    }

    const model = selectedModelRef.current;
    const sessionConfig = configRef.current;
    if (!model) {
      setPhase("idle");
      return;
    }

    stopPcmPlayer();
    const player = new PcmPlayer();
    pcmPlayerRef.current = player;
    void player.resume();

    const socket = new WebSocket(getRealtimeUrl(serverAddressRef.current));
    socketRef.current = socket;

    socket.onopen = () => {
      if (generation !== generationRef.current || stoppingRef.current) {
        return;
      }
      socket.send(
        encodeClientMessage({
          type: "session.start",
          model: model.id,
          config: sessionConfig,
        })
      );
    };

    socket.onmessage = (event) => {
      if (generation !== generationRef.current) {
        return;
      }
      if (typeof event.data !== "string") {
        return;
      }
      handleServerPayload(event.data);
    };

    socket.onerror = () => {
      if (endingRef.current) {
        endingRef.current.reject(new Error("WebSocket connection failed"));
        return;
      }
      if (generation !== generationRef.current || stoppingRef.current) {
        return;
      }
      setFatalError("WebSocket connection failed");
      cleanupSession();
    };

    socket.onclose = () => {
      if (endingRef.current) {
        endingRef.current.reject(new Error("Session closed before session.ended"));
        return;
      }
      if (generation !== generationRef.current || stoppingRef.current) {
        return;
      }
      setFatalError((current) => current ?? "Session ended");
      cleanupSession();
    };
  }

  function stop() {
    void endSession();
  }

  async function endSession() {
    if (stoppingRef.current) {
      return;
    }
    stoppingRef.current = true;
    setRecoverableError(null);
    setFatalError(null);
    stopFrameTimer();
    liveRef.current = false;
    stopPcmCapture();
    stopPcmPlayer();

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      generationRef.current += 1;
      closeSocket();
      resetTransientState();
      stoppingRef.current = false;
      return;
    }

    let clearWaiter: (() => void) | undefined;
    const ended = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (endingRef.current === waiter) {
          endingRef.current = null;
        }
        if (!settled) {
          settled = true;
          reject(new Error("Timed out waiting for session.ended"));
        }
      }, SESSION_END_ACK_TIMEOUT_MS);
      const finish = (action: () => void) => {
        window.clearTimeout(timeoutId);
        if (endingRef.current === waiter) {
          endingRef.current = null;
        }
        if (!settled) {
          settled = true;
          action();
        }
      };
      const waiter: SessionEndWaiter = {
        resolve: () => {
          finish(resolve);
        },
        reject: (error) => {
          finish(() => {
            reject(error);
          });
        },
      };
      clearWaiter = () => {
        window.clearTimeout(timeoutId);
        if (endingRef.current === waiter) {
          endingRef.current = null;
        }
      };
      endingRef.current = waiter;
    });

    try {
      socket.send(encodeClientMessage({ type: "session.end" }));
      await ended;
    } catch (error) {
      setFatalError(error instanceof Error ? error.message : "Session end failed");
    } finally {
      clearWaiter?.();
      generationRef.current += 1;
      closeSocket();
      resetTransientState();
      stoppingRef.current = false;
    }
  }

  async function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    await enqueueCapture(async () => {
      if (!liveRef.current) {
        setRecoverableError("Start a Session before sending a message");
        return;
      }
      if (!cameraLiveRef.current) {
        setRecoverableError("Turn on the camera to send a Frame with your message");
        return;
      }
      const video = videoRef.current;
      if (video) {
        await waitForVideoFrame(video);
      }
      const frame = captureFrame();
      if (!frame) {
        setRecoverableError("Could not capture a camera frame");
        return;
      }
      const sent = sendFeed(frame, trimmed);
      if (!sent) {
        setRecoverableError("The Session is not ready to send a Feed");
        return;
      }
      void pcmPlayerRef.current?.resume();
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "user",
          text: trimmed,
          streaming: false,
        },
      ]);
      setRecoverableError(null);
    });
  }

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      cameraRequestIdRef.current += 1;
      micRequestIdRef.current += 1;
      endingRef.current?.reject(new Error("unmounted"));
      cleanupSession();
      stopVideoPreview();
      stopMicrophoneTracks();
    };
    // Session and media resources are stored in refs and must be released on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup only
  }, []);

  const sessionActive = phase !== "idle";

  return {
    catalogStatus,
    catalogError,
    models,
    selectedModelId,
    config,
    serverAddress,
    framesPerSecond,
    selectedModel,
    phase,
    sessionId,
    recoverableError,
    fatalError,
    cameraError,
    cameraView,
    previewStream,
    cameraOn,
    micOn,
    micError,
    messages,
    debugEntries,
    isStreaming,
    sessionActive,
    canStart: catalogStatus === "ready" && Boolean(selectedModel) && phase === "idle",
    videoRef,
    setSelectedModelId: (id: string) => {
      if (sessionActive) {
        return;
      }
      const model = models.find((entry) => entry.id === id);
      if (model) {
        applyModel(model);
      }
    },
    setConfigValue: (key: string, value: unknown) => {
      if (sessionActive) {
        return;
      }
      setConfig((current) => {
        const next = { ...current, [key]: value };
        configRef.current = next;
        return next;
      });
    },
    setServerAddress: (value: string) => {
      if (sessionActive) {
        return;
      }
      setServerAddressState(value);
    },
    commitServerAddress: () => {
      commitServerAddress();
    },
    setFramesPerSecond: applyFramesPerSecond,
    reloadCatalog: () => {
      if (sessionActive) {
        return;
      }
      void loadCatalog();
    },
    start,
    stop,
    sendText,
    toggleCamera,
    toggleMicrophone,
  };
}

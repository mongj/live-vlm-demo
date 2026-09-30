"use client";

import { useAudioInputs, type AudioInputsState } from "@/hooks/use-audio-inputs";
import { useMediaDevices, type MediaDevicesState } from "@/hooks/use-media-devices";
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
import {
  assertSecureMediaContext,
  cameraConstraints,
  captureElementAudio,
  DEFAULT_DEVICE_ID,
  mediaDeviceErrorMessage,
  stopMediaStream,
} from "@/lib/media-devices";
import { typedInputPolicy } from "@/lib/model-input-policy.mjs";
import { encodePcmBase64, PcmPlayer } from "@/lib/pcm";
import {
  encodeClientMessage,
  inputTranscriptionFromRaw,
  parseServerMessage,
} from "@/lib/protocol";
import { getVideoLibrary } from "@/lib/video-library/library";
import type { VideoPlayback, VideoRecord } from "@/lib/video-library/types";
import { useEffect, useRef, useState, type RefObject } from "react";

export type CameraViewState = "empty" | "permission" | "connecting" | "live" | "error";

export type VideoSourceKind = "none" | "camera" | "file";

/** The chosen video input, remembered while video is off. */
export type VideoInput = { kind: "camera"; deviceId: string } | { kind: "library" };

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
  videoSource: VideoSourceKind;
  previewStream: MediaStream | null;
  videoFileUrl: string | null;
  activeVideo: VideoRecord | null;
  lastLibraryVideo: VideoRecord | null;
  videoInput: VideoInput;
  cameraOn: boolean;
  audio: AudioInputsState;
  devices: MediaDevicesState;
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
  /** Turns the chosen video input on or off; frames are only sent while it is on. */
  toggleVideo: () => void;
  selectCamera: (deviceId: string) => void;
  selectVideo: (video: VideoRecord) => void;
  clearVideo: () => void;
  reportVideoFileError: () => void;
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

function videoFileErrorMessage(): string {
  return "The browser could not play this video file";
}

export function usePlayground(initialModels: CatalogModel[], initialCatalogError: string | null): PlaygroundState {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const videoAudioStreamRef = useRef<MediaStream | null>(null);
  const pcmPlayerRef = useRef<PcmPlayer | null>(null);
  const frameTimerRef = useRef<number | null>(null);
  const lastSentTRef = useRef<number | null>(null);
  const generationRef = useRef(0);
  const cameraRequestIdRef = useRef(0);
  const fileRequestIdRef = useRef(0);
  const captureTailRef = useRef(Promise.resolve());
  const liveRef = useRef(false);
  const sourceLiveRef = useRef(false);
  const cameraInFlightRef = useRef(false);
  const playbackRef = useRef<VideoPlayback | null>(null);
  const videoSourceRef = useRef<VideoSourceKind>("none");
  const streamingAssistantIdRef = useRef<string | null>(null);
  const streamingUserIdRef = useRef<string | null>(null);
  const streamingDebugIdRef = useRef<string | null>(null);
  const assistantTurnOpenRef = useRef(false);
  const discardReplyAudioRef = useRef(false);
  const suppressInputBargeInRef = useRef(false);
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
  const [videoSource, setVideoSource] = useState<VideoSourceKind>("none");
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [videoFileUrl, setVideoFileUrl] = useState<string | null>(null);
  const [activeVideo, setActiveVideo] = useState<VideoRecord | null>(null);
  const [lastLibraryVideo, setLastLibraryVideo] = useState<VideoRecord | null>(null);
  const [videoInput, setVideoInput] = useState<VideoInput>({ kind: "camera", deviceId: DEFAULT_DEVICE_ID });
  const [videoAudioStream, setVideoAudioStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [debugEntries, setDebugEntries] = useState<DebugRawEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const devices = useMediaDevices();
  const audio = useAudioInputs({
    capturing: phase === "live",
    videoAudioStream,
    onChunk: sendAudio,
    onSpeechStart: maybeBargeInFromMic,
    onPermissionGranted: devices.refresh,
  });
  const outputDeviceId = audio.outputDeviceId;
  const outputDeviceIdRef = useRef(outputDeviceId);
  outputDeviceIdRef.current = outputDeviceId;

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

  function applyVideoSource(next: VideoSourceKind) {
    videoSourceRef.current = next;
    setVideoSource(next);
  }

  function releasePlayback() {
    playbackRef.current?.release();
    playbackRef.current = null;
  }

  function detachFileFromVideo() {
    const video = videoRef.current;
    if (!video || video.srcObject) {
      return;
    }
    if (video.getAttribute("src")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  function stopCameraPreview() {
    const stream = videoStreamRef.current;
    videoStreamRef.current = null;
    setPreviewStream(null);
    stopMediaStream(stream);
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }

  function stopVideoPreview() {
    sourceLiveRef.current = false;
    stopCameraPreview();
  }

  function releaseVideoAudio() {
    stopMediaStream(videoAudioStreamRef.current);
    videoAudioStreamRef.current = null;
    setVideoAudioStream(null);
  }

  function attachVideoAudio(element: HTMLVideoElement) {
    releaseVideoAudio();
    const captured = captureElementAudio(element);
    if (!captured) {
      return;
    }
    videoAudioStreamRef.current = captured;
    const publish = () => {
      if (videoAudioStreamRef.current !== captured) {
        return;
      }
      const hasAudio = captured.getAudioTracks().length > 0;
      setVideoAudioStream(hasAudio ? captured : null);
      if (hasAudio) {
        audio.setVideoAudioSelected(true);
      }
    };
    captured.addEventListener("addtrack", publish);
    captured.addEventListener("removetrack", publish);
    publish();
  }

  function clearFileSourceState() {
    releasePlayback();
    releaseVideoAudio();
    setVideoFileUrl(null);
    setActiveVideo(null);
  }

  function stopPcmPlayer() {
    pcmPlayerRef.current?.close();
    pcmPlayerRef.current = null;
  }

  function createPcmPlayer(): PcmPlayer {
    const player = new PcmPlayer();
    void player.setOutputDevice(outputDeviceIdRef.current).catch(() => undefined);
    return player;
  }

  function ensurePcmPlayer(): PcmPlayer {
    if (!pcmPlayerRef.current) {
      pcmPlayerRef.current = createPcmPlayer();
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

  function replyPlaybackActive(): boolean {
    return assistantTurnOpenRef.current || Boolean(pcmPlayerRef.current?.isActive());
  }

  function interruptPlayback() {
    const hadOpenTurn = assistantTurnOpenRef.current;
    pcmPlayerRef.current?.stop();
    if (hadOpenTurn) {
      discardReplyAudioRef.current = true;
    }
    suppressInputBargeInRef.current = true;
  }

  function maybeBargeInFromMic() {
    if (replyPlaybackActive()) {
      interruptPlayback();
    }
  }

  function playReplyAudio(pcmBase64: string) {
    if (discardReplyAudioRef.current) {
      return;
    }
    const player = ensurePcmPlayer();
    player.enqueue(pcmBase64);
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
    streamingUserIdRef.current = null;
    streamingDebugIdRef.current = null;
    assistantTurnOpenRef.current = false;
    discardReplyAudioRef.current = false;
    suppressInputBargeInRef.current = false;
    setIsStreaming(false);
    setSessionId(null);
    setPhase("idle");
    setMessages([]);
    setDebugEntries([]);
  }

  function cleanupSession() {
    stopFrameTimer();
    closeSocket();
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
    if (!liveRef.current || !sourceLiveRef.current) {
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
        void ensurePcmPlayer().resume();
        break;
      case "response.chunk": {
        const chunk = message.text ?? "";
        const presentable = hasPresentableText(chunk);
        const rawChunk = message.raw ?? "";
        const presentableRaw = hasRawOutput(rawChunk);
        const inputChunk = inputTranscriptionFromRaw(rawChunk);
        const presentableInput = hasPresentableText(inputChunk);

        if (message.interrupted) {
          interruptPlayback();
        } else if (
          presentableInput &&
          replyPlaybackActive() &&
          !suppressInputBargeInRef.current
        ) {
          interruptPlayback();
        }
        if (presentableInput) {
          suppressInputBargeInRef.current = true;
        }
        if (message.audio) {
          playReplyAudio(message.audio);
        }
        if ((message.audio || presentable) && !message.final) {
          assistantTurnOpenRef.current = true;
        }
        if (presentable && !discardReplyAudioRef.current) {
          suppressInputBargeInRef.current = false;
        }

        if (presentableInput) {
          const streamingId = streamingUserIdRef.current;
          const userStreaming = !message.final && !presentable;
          if (streamingId) {
            setMessages((current) =>
              current.map((entry) =>
                entry.id === streamingId
                  ? {
                      ...entry,
                      text: inputChunk,
                      streaming: userStreaming,
                    }
                  : entry
              )
            );
          } else {
            const id = crypto.randomUUID();
            if (userStreaming) {
              streamingUserIdRef.current = id;
            }
            setMessages((current) => [
              ...current,
              {
                id,
                role: "user",
                text: inputChunk,
                streaming: userStreaming,
              },
            ]);
          }
        } else if (streamingUserIdRef.current && (message.final || presentable)) {
          const streamingId = streamingUserIdRef.current;
          setMessages((current) =>
            current.map((entry) => (entry.id === streamingId ? { ...entry, streaming: false } : entry))
          );
        }

        if (message.final || presentable) {
          streamingUserIdRef.current = null;
        }

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
          assistantTurnOpenRef.current = false;
          discardReplyAudioRef.current = false;
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
    applyVideoSource("none");
  }

  async function enableCamera(deviceId: string) {
    const requestId = cameraRequestIdRef.current + 1;
    cameraRequestIdRef.current = requestId;
    fileRequestIdRef.current += 1;
    cameraInFlightRef.current = true;
    sourceLiveRef.current = false;
    detachFileFromVideo();
    clearFileSourceState();
    applyVideoSource("camera");
    setCameraError(null);
    setCameraView("permission");
    try {
      assertSecureMediaContext("camera");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: cameraConstraints(deviceId),
      });
      if (requestId !== cameraRequestIdRef.current) {
        stopMediaStream(stream);
        return;
      }
      devices.refresh();
      setCameraView("connecting");
      videoStreamRef.current = stream;
      setPreviewStream(stream);
      const video = videoRef.current;
      if (video) {
        if (video.getAttribute("src")) {
          video.removeAttribute("src");
        }
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        await waitForVideoFrame(video);
      }
      if (requestId !== cameraRequestIdRef.current) {
        stopVideoPreview();
        return;
      }
      sourceLiveRef.current = true;
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

  function enableVideoInput() {
    switch (videoInput.kind) {
      case "camera":
        void enableCamera(videoInput.deviceId);
        return;
      case "library":
        if (lastLibraryVideo) {
          void selectVideo(lastLibraryVideo);
        }
        return;
      default: {
        const exhaustive: never = videoInput;
        return exhaustive;
      }
    }
  }

  function toggleVideo() {
    switch (videoSourceRef.current) {
      case "file":
        clearVideo();
        return;
      case "camera":
        if (sourceLiveRef.current || cameraInFlightRef.current) {
          disableCamera();
          return;
        }
        enableVideoInput();
        return;
      case "none":
        if (cameraInFlightRef.current) {
          disableCamera();
          return;
        }
        enableVideoInput();
        return;
      default: {
        const exhaustive: never = videoSourceRef.current;
        return exhaustive;
      }
    }
  }

  function selectCamera(deviceId: string) {
    setVideoInput({ kind: "camera", deviceId });
    void enableCamera(deviceId);
  }

  async function attachVideoFile(url: string, requestId: number): Promise<void> {
    const video = videoRef.current;
    if (!video) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    const element = videoRef.current;
    if (!element) {
      throw new Error("Video preview is not available");
    }
    if (requestId !== fileRequestIdRef.current) {
      return;
    }
    if (element.srcObject) {
      element.srcObject = null;
    }
    element.muted = true;
    element.playsInline = true;
    if (element.src !== url) {
      element.src = url;
    }
    void element.play().catch(() => undefined);
    const ready = await waitForVideoFrame(element);
    if (requestId !== fileRequestIdRef.current) {
      return;
    }
    if (!ready || element.error) {
      throw new Error(videoFileErrorMessage());
    }
    void element.play().catch(() => undefined);
  }

  async function selectVideo(video: VideoRecord) {
    const requestId = fileRequestIdRef.current + 1;
    fileRequestIdRef.current = requestId;
    cameraRequestIdRef.current += 1;
    cameraInFlightRef.current = false;
    sourceLiveRef.current = false;
    stopCameraPreview();
    detachFileFromVideo();
    releasePlayback();

    setCameraOn(false);
    setCameraError(null);
    releaseVideoAudio();
    applyVideoSource("file");
    setActiveVideo(video);
    setLastLibraryVideo(video);
    setVideoInput({ kind: "library" });
    setVideoFileUrl(null);
    setCameraView("connecting");

    try {
      const playback = await getVideoLibrary().open(video);
      if (requestId !== fileRequestIdRef.current) {
        playback.release();
        return;
      }
      playbackRef.current = playback;
      setVideoFileUrl(playback.url);
      await attachVideoFile(playback.url, requestId);
    } catch (error) {
      if (requestId !== fileRequestIdRef.current) {
        return;
      }
      sourceLiveRef.current = false;
      setCameraError(error instanceof Error ? error.message : videoFileErrorMessage());
      setCameraView("error");
      return;
    }

    if (requestId !== fileRequestIdRef.current) {
      return;
    }

    if (videoRef.current) {
      attachVideoAudio(videoRef.current);
    }
    sourceLiveRef.current = true;
    setCameraView("live");
    if (liveRef.current) {
      void enqueueCapture(async () => {
        sendLiveFrame();
      });
    }
  }

  function clearVideo() {
    if (videoSourceRef.current !== "file" && !playbackRef.current) {
      return;
    }
    fileRequestIdRef.current += 1;
    sourceLiveRef.current = false;
    clearFileSourceState();
    detachFileFromVideo();
    applyVideoSource("none");
    setCameraError(null);
    setCameraView("empty");
  }

  function reportVideoFileError() {
    if (videoSourceRef.current !== "file") {
      return;
    }
    sourceLiveRef.current = false;
    setCameraError(videoFileErrorMessage());
    setCameraView("error");
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
    const player = createPcmPlayer();
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
    const inputPolicy = typedInputPolicy(selectedModelIdRef.current, liveRef.current);
    if (!inputPolicy.enabled) {
      setRecoverableError(inputPolicy.notice ?? "Start a Session before sending a message");
      return;
    }
    interruptPlayback();
    await enqueueCapture(async () => {
      if (!liveRef.current) {
        setRecoverableError("Start a Session before sending a message");
        return;
      }
      if (!sourceLiveRef.current) {
        setRecoverableError("Turn on the camera or upload a video to send a Frame with your message");
        return;
      }
      const video = videoRef.current;
      if (video) {
        await waitForVideoFrame(video);
      }
      const frame = captureFrame();
      if (!frame) {
        setRecoverableError("Could not capture a video frame");
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
      fileRequestIdRef.current += 1;
      endingRef.current?.reject(new Error("unmounted"));
      cleanupSession();
      stopVideoPreview();
      clearFileSourceState();
    };
    // Session and media resources are stored in refs and must be released on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup only
  }, []);

  useEffect(() => {
    void pcmPlayerRef.current?.setOutputDevice(outputDeviceId).catch(() => undefined);
  }, [outputDeviceId]);

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
    videoSource,
    previewStream,
    videoFileUrl,
    activeVideo,
    lastLibraryVideo,
    videoInput,
    cameraOn,
    audio: {
      ...audio,
      toggle: () => {
        void pcmPlayerRef.current?.resume();
        audio.toggle();
      },
    },
    devices,
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
    toggleVideo,
    selectCamera,
    selectVideo: (video: VideoRecord) => {
      void selectVideo(video);
    },
    clearVideo,
    reportVideoFileError,
  };
}

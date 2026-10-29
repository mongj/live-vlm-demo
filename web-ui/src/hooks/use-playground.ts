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
import { emptyInputFeedback, reduceInputFeedback, type InputFeedback, type InputCaption } from "@/lib/input-feedback.mjs";
import { updateGuidance, type GuidanceState } from "@/lib/assistant-guidance.mjs";
import { decodePcmBase64, encodePcmBase64, PcmPlayer } from "@/lib/pcm";
import { CaptionTimeline } from "@/lib/playback-captions";
import { emptyPlaybackDiagnostics, recordPlaybackEvent, type PlaybackDiagnostics, type StopReason } from "@/lib/playback-diagnostics.mjs";
import { appendRuntimeDiagnostic, type RuntimeDiagnosticEntry } from "@/lib/runtime-diagnostics.mjs";
import { FrameRates, type FrameRateSnapshot } from "@/lib/frame-rates";
import { readPreference, writePreference, type CaptionSize } from "@/lib/playground-preferences";
import { SessionEvidence, sessionLogFilename, sanitizeEvidenceSnapshot, safeFailureReason, overloadRecoveryMessage, type EvidenceEvent, type EvidenceReason, type SessionLogSummary, type TranscriptEndReason, type TranscriptInterruptionSource } from "@/lib/session-evidence";
import { generationConfigErrors, generationEvidence } from "@/lib/generation-config";
import { SessionLogArchive, type SessionLogArchiveState } from "@/lib/session-log-archive";
import { canUpdateSessionActivity, describeSessionStatusView, type SessionConnection, type SessionActivity, type SessionStatusBadge } from "@/lib/session-status";
import {
  encodeClientMessage,
  inputTranscriptionFromRaw,
  parseServerMessage,
  type SpeechCapabilities,
  type InputFeedbackEvent,
} from "@/lib/protocol";
import { getVideoLibrary } from "@/lib/video-library/library";
import type { VideoPlayback, VideoRecord } from "@/lib/video-library/types";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

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
  source?: "voice" | "typed";
  status?: string;
  statusDetail?: string;
  turnOrder?: number;
  endReason?: TranscriptEndReason;
  interruptionSource?: TranscriptInterruptionSource;
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
  frameRates: FrameRateSnapshot;
  modelMuted: boolean;
  toggleModelMuted: () => void;
  modelVolume: number;
  setModelVolume: (volume: number) => void;
  captionsEnabled: boolean;
  toggleCaptions: () => void;
  captionSize: CaptionSize;
  setCaptionSize: (size: CaptionSize) => void;
  captionBackgroundOpacity: number;
  setCaptionBackgroundOpacity: (opacity: number) => void;
  resetCaptionAppearance: () => void;
  selectedModel: CatalogModel | undefined;
  phase: SessionPhase;
  sessionId: string | null;
  /** Monotonic browser time at session acceptance; null before acceptance and after cleanup. */
  sessionStartedAtMonotonicMs: number | null;
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
  guidance: GuidanceState | null;
  inputCaption: InputCaption | null;
  inputStatus: string;
  typedBusy: boolean;
  speechCapabilities: SpeechCapabilities | null;
  sessionNotice: string | null;
  sessionStatus: string;
  sessionStatusBadge: SessionStatusBadge;
  sessionLogSummary: SessionLogSummary | null;
  markSessionIssue: () => void;
  markSessionStateChange: () => void;
  stateChangeShortcutHeld: boolean;
  downloadSessionLog: () => void;
  savedSessionLogs: SessionLogArchiveState;
  savedLogDownloadStatus: string;
  includeTranscript: boolean;
  setIncludeTranscript: (enabled:boolean) => void;
  downloadSavedSessionLog: (startedAt:number) => void;
  clearSavedSessionLogs: () => void;
  debugEntries: DebugRawEntry[];
  playbackDiagnostics: PlaybackDiagnostics;
  runtimeDiagnostics: RuntimeDiagnosticEntry[];
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
  sendText: (text: string) => Promise<boolean>;
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
  const captionTimelineRef = useRef(new CaptionTimeline());
  const captionTimerRef = useRef<number | null>(null);
  const captionObservationKeyRef = useRef<string | null>(null);
  const lastReplyOrderRef = useRef(-1);
  const voiceInterruptOrderRef = useRef(-1);
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
  const microphoneSpeechActiveRef = useRef(false);
  const suppressInputBargeInRef = useRef(false);
  const stoppingRef = useRef(false);
  const endingRef = useRef<SessionEndWaiter | null>(null);
  const feedbackRef = useRef<InputFeedback>(emptyInputFeedback());
  const speechRef = useRef<SpeechCapabilities | null>(null);
  const micGenerationRef = useRef(0);
  const micSequenceRef = useRef(0);
  const typedWaiterRef = useRef<{id:string;resolve:(sent:boolean)=>void;timer:ReturnType<typeof setTimeout>} | null>(null);
  const frameRatesRef = useRef(new FrameRates());
  const modelMutedRef = useRef(false);
  const modelVolumeRef = useRef(1);
  const lastAudibleVolumeRef = useRef(1);
  const captionsEnabledRef = useRef(true);
  const evidenceRef = useRef<SessionEvidence | null>(null);
  const archivedEvidenceRef = useRef(new WeakSet<SessionEvidence>());
  const [savedSessionLogs,setSavedSessionLogs] = useState<SessionLogArchiveState>({logs:[],storage:"loading"});
  const [savedLogDownloadStatus,setSavedLogDownloadStatus] = useState("");
  const archiveRef = useRef<SessionLogArchive | null>(null);
  const archiveMountedRef = useRef(false);
  if (!archiveRef.current) archiveRef.current=new SessionLogArchive(undefined,()=>{
    if (archiveMountedRef.current) setSavedSessionLogs(archiveRef.current!.state());
  });
  const microphoneSentRef = useRef(false);
  const evidencePublishedAtRef = useRef(-Infinity);
  const [sessionLogSummary, setSessionLogSummary] = useState<SessionLogSummary | null>(null);
  const [sessionConnection, setSessionConnection] = useState<SessionConnection>("none");
  const [sessionActivity, setSessionActivity] = useState<SessionActivity>("idle");
  const [stateChangeShortcutHeld, setStateChangeShortcutHeld] = useState(false);
  const markStateChangeRef = useRef<(source:"button"|"keyboard")=>void>(()=>{});
  markStateChangeRef.current = (source) => {
    if (liveRef.current && !stoppingRef.current) recordEvidence("state_change",{markerSource:source});
  };

  useEffect(() => {
    const release = () => setStateChangeShortcutHeld(false);
    const down = (event:KeyboardEvent) => {
      if (!liveRef.current || stoppingRef.current || event.defaultPrevented || event.repeat || event.isComposing
        || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.key.toLowerCase() !== "m") return;
      const target=event.target;
      if (target instanceof Element && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]')) return;
      event.preventDefault();
      setStateChangeShortcutHeld(true);
      markStateChangeRef.current("keyboard");
    };
    const up = (event:KeyboardEvent) => {
      if (event.key.toLowerCase() === "m" || event.key === "Shift") release();
    };
    window.addEventListener("keydown",down);
    window.addEventListener("keyup",up);
    window.addEventListener("blur",release);
    return () => {
      window.removeEventListener("keydown",down);
      window.removeEventListener("keyup",up);
      window.removeEventListener("blur",release);
    };
  }, []);

  function recordEvidence(event:EvidenceEvent, data:Record<string,unknown>={}) {
    const log=evidenceRef.current;
    if (!log) return;
    log.add(event,data);
    const now=performance.now();
    if (!["input","output","diagnostic","playback","caption_timeline"].includes(event) || now-evidencePublishedAtRef.current >= 1000) {
      evidencePublishedAtRef.current=now;
      setSessionLogSummary(log.summary());
    }
  }

  function archiveCompletedEvidence(log:SessionEvidence) {
    if (!log.summary().terminal || archivedEvidenceRef.current.has(log)) return;
    archivedEvidenceRef.current.add(log);
    void archiveRef.current?.save(log.snapshot());
  }

  function downloadEvidence(value:unknown):string {
    const snapshot=sanitizeEvidenceSnapshot(value,false);
    if (!snapshot) return "Download unavailable · retry manually";
    let url:string | null=null;
    let anchor:HTMLAnchorElement | null=null;
    try {
      const bundle={session:snapshot};
      url=URL.createObjectURL(new Blob([JSON.stringify(bundle)],{type:"application/json"}));
      anchor=document.createElement("a");
      anchor.href=url;
      anchor.download=sessionLogFilename(snapshot.startedAt);
      anchor.hidden=true;
      document.body.appendChild(anchor);
      anchor.click();
      return "Download requested · check browser downloads";
    } catch {
      return "Download unavailable · retry manually";
    } finally {
      anchor?.remove();
      if (url) { const release=url; window.setTimeout(()=>URL.revokeObjectURL(release),1000); }
    }
  }

  function downloadSessionLog() {
    const log=evidenceRef.current;
    if (!log || log.summary().terminal) return;
    log.setDownloadStatus(downloadEvidence(log.snapshot()) as Parameters<SessionEvidence["setDownloadStatus"]>[0]);
    setSessionLogSummary(log.summary());
  }

  function downloadSavedSessionLog(startedAt:number) {
    const log=archiveRef.current?.state().logs.find(item=>item.startedAt === startedAt);
    if (log) setSavedLogDownloadStatus(downloadEvidence(log));
  }

  function clearSavedSessionLogs() {
    setSavedLogDownloadStatus("");
    void archiveRef.current?.clear();
  }

  function recordSessionFailure(reason:EvidenceReason, terminal=true) {
    const log=evidenceRef.current;
    if (!log) return;
    if (terminal) {
      recordCaptionClear("failure");
      pcmPlayerRef.current?.stop("closed");
      log.finish(reason);
      archiveCompletedEvidence(log);
      setSessionConnection("failed");
      setSessionActivity("idle");
    } else log.add("failure",{reason});
    setSessionLogSummary(log.summary());
  }

  function finishEvidence(reason:EvidenceReason) {
    const log=evidenceRef.current;
    if (!log) return;
    recordCaptionClear("session_ended");
    pcmPlayerRef.current?.stop("closed");
    log.finish(reason);
    archiveCompletedEvidence(log);
    setSessionLogSummary(log.summary());
    setSessionConnection(current=>current === "failed" ? current : "closed");
    setSessionActivity("idle");
  }

  const [catalogStatus, setCatalogStatus] = useState<"loading" | "ready" | "error">(
    initialCatalogError ? "error" : initialModels.length > 0 ? "ready" : "error"
  );
  const [catalogError, setCatalogError] = useState<string | null>(
    initialCatalogError ?? (initialModels.length > 0 ? null : "Catalog did not return any models")
  );
  const [models, setModels] = useState<CatalogModel[]>(initialModels);
  const initialModel = initialModels.find(model => model.id === "minicpm-o-4-5") ?? initialModels[0];
  const [selectedModelId, setSelectedModelIdState] = useState(initialModel?.id ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(() =>
    initialModel ? defaultsFromSchema(initialModel.config_schema) : {}
  );
  const [serverAddress, setServerAddressState] = useState(DEFAULT_GATEWAY_ADDRESS);
  const [framesPerSecond, setFramesPerSecondState] = useState(DEFAULT_FRAMES_PER_SECOND);
  const [frameRates, setFrameRates] = useState<FrameRateSnapshot>({captured:null,submitted:null,upstream:null});
  const [modelMuted, setModelMuted] = useState(false);
  const [modelVolume, setModelVolumeState] = useState(1);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [captionSize, setCaptionSizeState] = useState<CaptionSize>("compact");
  const [captionBackgroundOpacity, setCaptionBackgroundOpacityState] = useState(0.5);
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStartedAtMonotonicMs, setSessionStartedAtMonotonicMs] = useState<number | null>(null);
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
  const [messages, setMessagesState] = useState<TranscriptMessage[]>([]);
  const messagesRef = useRef<TranscriptMessage[]>([]);
  const [includeTranscript,setIncludeTranscript] = useState(true);
  function setMessages(update:TranscriptMessage[]|((current:TranscriptMessage[])=>TranscriptMessage[])) {
    const next=typeof update === "function" ? update(messagesRef.current) : update;
    messagesRef.current=next;
    evidenceRef.current?.captureTranscript(next);
    setMessagesState(next);
  }
  const [guidance, setGuidance] = useState<GuidanceState | null>(null);
  const [inputFeedback, setInputFeedback] = useState<InputFeedback>(emptyInputFeedback);
  const [speechCapabilities, setSpeechCapabilities] = useState<SpeechCapabilities | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [debugEntries, setDebugEntries] = useState<DebugRawEntry[]>([]);
  const [playbackDiagnostics, setPlaybackDiagnostics] = useState(emptyPlaybackDiagnostics);
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<RuntimeDiagnosticEntry[]>([]);
  const runtimeDiagnosticsRef = useRef<RuntimeDiagnosticEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [microphoneSpeechActive, setMicrophoneSpeechActive] = useState(false);

  useEffect(() => {
    const volume = readPreference("modelVolume");
    const captions = readPreference("captionsEnabled");
    modelVolumeRef.current = volume;
    if (volume > 0) lastAudibleVolumeRef.current = volume;
    modelMutedRef.current = volume === 0;
    captionsEnabledRef.current = captions;
    // Browser preferences are unavailable during SSR; hydrate once after the matching first render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModelVolumeState(volume);
    setModelMuted(volume === 0);
    setCaptionsEnabled(captions);
    setCaptionSizeState(readPreference("captionSize"));
    setCaptionBackgroundOpacityState(readPreference("captionBackgroundOpacity"));
    pcmPlayerRef.current?.setVolume(volume);
    pcmPlayerRef.current?.setMuted(volume === 0);
  }, []);

  function setCaptionSize(size: CaptionSize) {
    if (size !== "compact" && size !== "normal" && size !== "large") return;
    setCaptionSizeState(size);
    writePreference("captionSize", size);
  }

  function setCaptionBackgroundOpacity(opacity: number) {
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) return;
    setCaptionBackgroundOpacityState(opacity);
    writePreference("captionBackgroundOpacity", opacity);
  }

  function resetCaptionAppearance() {
    setCaptionSize("compact");
    setCaptionBackgroundOpacity(0.5);
  }

  function setModelVolume(value: number) {
    if (!Number.isFinite(value)) return;
    const volume = Math.max(0, Math.min(1, value));
    modelVolumeRef.current = volume;
    if (volume > 0) lastAudibleVolumeRef.current = volume;
    modelMutedRef.current = volume === 0;
    setModelVolumeState(volume);
    setModelMuted(volume === 0);
    if (volume === 0) captionTimelineRef.current.mute(pcmPlayerRef.current?.clockTime() ?? 0, performance.now());
    pcmPlayerRef.current?.setVolume(volume);
    pcmPlayerRef.current?.setMuted(volume === 0);
    writePreference("modelVolume", volume);
  }

  const devices = useMediaDevices();
  const audio = useAudioInputs({
    capturing: phase === "live",
    videoAudioStream,
    onChunk: sendAudio,
    onSpeechStart: maybeBargeInFromMic,
    onSpeechEnd: () => {
      microphoneSpeechActiveRef.current = false;
      setMicrophoneSpeechActive(false);
      recordEvidence("input_status", {source:"microphone",state:"speech_end"});
    },
    onPermissionGranted: devices.refresh,
    onMicrophoneChunk: sendMicrophone,
    onMicrophoneReset: resetMicrophone,
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

  function recordClientConfiguration() {
    recordEvidence("client_config", {
      configurationSource:"browser_observed", telemetryRevision:2,
      requestedFps:framesPerSecondRef.current, microphoneMode:audio.mode,
      microphoneEnabled:audio.enabled, videoSource:videoSourceRef.current,
      videoAudioSelected:audio.videoAudioSelected, captionsEnabled:captionsEnabledRef.current,
    });
  }

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
      const next = current ?? nextModels.find(model => model.id === "minicpm-o-4-5") ?? nextModels[0];
      if (next) applyModel(next);
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

  function stopPcmPlayer(clearReason:"reset"|"session_ended" = "reset") {
    cancelCaptions(clearReason);
    if (captionTimerRef.current !== null) window.clearInterval(captionTimerRef.current);
    captionTimerRef.current = null;
    pcmPlayerRef.current?.close();
    pcmPlayerRef.current = null;
  }

  function createPcmPlayer(): PcmPlayer {
    const sessionLog = evidenceRef.current;
    const player = new PcmPlayer((event) => {
      // AudioContext promises/callbacks may outlive a session. Never attach
      // an old player's completion to a newly created diagnostic log.
      if (evidenceRef.current === sessionLog) recordEvidence("playback", { ...event });
    });
    player.setVolume(modelVolumeRef.current);
    player.setMuted(modelMutedRef.current);
    void player.setOutputDevice(outputDeviceIdRef.current).catch(() => undefined);
    return player;
  }

  function ensurePcmPlayer(): PcmPlayer {
    if (!pcmPlayerRef.current) {
      pcmPlayerRef.current = createPcmPlayer();
    }
    return pcmPlayerRef.current;
  }

  function recordCaptionClear(captionClearReason:"reset"|"interrupted"|"session_ended"|"failure", source?:StopReason) {
    if (captionObservationKeyRef.current !== null || captionTimelineRef.current.isActive()) {
      recordEvidence("caption_timeline",{captionState:"cleared",captionClearReason,source,textChars:0});
    }
    captionObservationKeyRef.current=null;
  }

  function cancelCaptions(reason:"reset"|"interrupted"|"session_ended"|"failure" = "reset", source?:StopReason) {
    recordCaptionClear(reason,source);
    captionTimelineRef.current.cancel();
    setGuidance(null);
  }

  function refreshCaptions() {
    const text=captionTimelineRef.current.read(pcmPlayerRef.current?.clockTime() ?? 0,performance.now());
    const observation=captionTimelineRef.current.observation();
    const key=observation ? JSON.stringify(observation) : null;
    if (key !== captionObservationKeyRef.current) {
      captionObservationKeyRef.current=key;
      if (observation) recordEvidence("caption_timeline",{captionState:"observed",...observation});
    }
    const streaming=assistantTurnOpenRef.current;
    setGuidance(current=> current?.text === text && current.streaming === streaming ? current
      : text ? {text,streaming,modelId:selectedModelIdRef.current} : null);
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
    if (audio.holding && audio.listening) microphoneSentRef.current=true;
    recordEvidence("input",{source:"mixed_audio",bytes:pcm.byteLength});
  }

  function applyInputFeedback(event: InputFeedbackEvent) {
    const next = reduceInputFeedback(feedbackRef.current, event);
    if (next === feedbackRef.current) return next;
    feedbackRef.current = next;
    setInputFeedback(next);
    setMessages(current => {
      const incoming = new Map(next.entries.map(entry => [entry.id, entry]));
      const result = current.map(entry => incoming.get(entry.id) ?? entry);
      const existing = new Set(current.map(entry => entry.id));
      result.push(...next.entries.filter(entry => !existing.has(entry.id)));
      return result.filter(entry=>entry.status !== 'no_speech').sort((a,b) => (a.turnOrder ?? 0) - (b.turnOrder ?? 0));
    });
    return next;
  }

  function resetMicrophone() {
    micGenerationRef.current += 1;
    micSequenceRef.current = 0;
    if (!liveRef.current || !(speechRef.current?.transcription || speechRef.current?.spoken_interruption)) return;
    applyInputFeedback({type:'microphone',generation:micGenerationRef.current});
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(encodeClientMessage({type:'input.microphone',generation:micGenerationRef.current,sequence:0,enabled:false}));
  }

  function sendMicrophone(pcm: Uint8Array) {
    const socket = socketRef.current;
    if (!liveRef.current || !(speechRef.current?.transcription || speechRef.current?.spoken_interruption) || feedbackRef.current.busy || socket?.readyState !== WebSocket.OPEN) return;
    // A separate channel contains only already-enabled microphones, never video audio.
    if (socket.bufferedAmount > 256_000) { resetMicrophone(); return; }
    socket.send(encodeClientMessage({type:'input.microphone',generation:micGenerationRef.current,
      sequence:++micSequenceRef.current,enabled:true,pcm:encodePcmBase64(pcm)}));
    microphoneSentRef.current=true;
    recordEvidence("input",{source:"microphone",bytes:pcm.byteLength,generation:micGenerationRef.current,sequence:micSequenceRef.current});
  }

  function finishTyped(sent: boolean) {
    const pending = typedWaiterRef.current;
    typedWaiterRef.current = null;
    if (pending) { clearTimeout(pending.timer); pending.resolve(sent); }
  }

  function replyPlaybackActive(): boolean {
    return assistantTurnOpenRef.current || Boolean(pcmPlayerRef.current?.isActive()) || captionTimelineRef.current.isActive();
  }

  function interruptPlayback(reason: StopReason = 'typed', clearActivity=true) {
    const queuedAudioMs=pcmPlayerRef.current?.queuedMs() ?? 0;
    recordEvidence("interrupt",{source:reason,queuedAudioMs});
    if (clearActivity) setSessionActivity(current=>reason === "server" && current !== "responding" ? current : "idle");
    if (replyPlaybackActive()) {
      setPlaybackDiagnostics((current) => recordPlaybackEvent(current, {type:'interrupt',reason}));
    }
    const hadOpenTurn = assistantTurnOpenRef.current;
    cancelCaptions("interrupted",reason);
    const cancelledAudioMs=pcmPlayerRef.current?.stop("interrupted") ?? 0;
    recordEvidence("playback",{source:reason,state:"stopped",cancelledAudioMs});
    const interruptedId = streamingAssistantIdRef.current;
    if (interruptedId) {
      setMessages(current => current.map(entry => entry.id === interruptedId ? { ...entry, streaming: false, endReason:"interrupted", interruptionSource:reason } : entry));
      streamingAssistantIdRef.current = null;
    }
    setIsStreaming(false);
    if (hadOpenTurn) {
      discardReplyAudioRef.current = true;
    }
    suppressInputBargeInRef.current = true;
  }

  function maybeBargeInFromMic() {
    microphoneSpeechActiveRef.current = true;
    setMicrophoneSpeechActive(true);
    recordEvidence("input_status",{source:"microphone",state:"speech_onset"});
    if (replyPlaybackActive()) {
      interruptPlayback('microphone');
    }
  }

  function playReplyAudio(pcmBase64: string, accepted = true, caption_unit?:number) {
    try {
      const bytes = decodePcmBase64(pcmBase64).byteLength;
      const discarded = !accepted || discardReplyAudioRef.current || modelMutedRef.current;
      recordEvidence("playback",{bytes,discarded,caption_unit});
      setPlaybackDiagnostics((current) => recordPlaybackEvent(current, {type:'audio',bytes,discarded}));
    } catch {
      // The player already ignores malformed PCM; do not count it as valid audio.
    }
    if (!accepted || discardReplyAudioRef.current || modelMutedRef.current) {
      return null;
    }
    const player = ensurePcmPlayer();
    const interval=player.enqueue(pcmBase64, caption_unit);
    void player.resume();
    return interval;
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
    frameRatesRef.current.reset();
    setFrameRates(frameRatesRef.current.read(performance.now()));
    audio.cancelCapture();
    finishTyped(false);
    feedbackRef.current = emptyInputFeedback();
    speechRef.current = null;
    setInputFeedback(feedbackRef.current);
    setSpeechCapabilities(null);
    liveRef.current = false;
    lastSentTRef.current = null;
    streamingAssistantIdRef.current = null;
    streamingUserIdRef.current = null;
    streamingDebugIdRef.current = null;
    assistantTurnOpenRef.current = false;
    discardReplyAudioRef.current = false;
    microphoneSpeechActiveRef.current = false;
    setMicrophoneSpeechActive(false);
    suppressInputBargeInRef.current = false;
    setStateChangeShortcutHeld(false);
    lastReplyOrderRef.current = -1;
    voiceInterruptOrderRef.current = -1;
    setIsStreaming(false);
    setSessionId(null);
    setSessionStartedAtMonotonicMs(null);
    setPhase("idle");
    setMessages([]);
    setGuidance(null);
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
    const frame = captureJpegBase64(video, canvasRef.current);
    if (frame) frameRatesRef.current.capture(performance.now());
    return frame;
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
    frameRatesRef.current.submit(performance.now());
    recordEvidence("input",{source:text !== undefined ? "typed" : "video",hasFrame:true,hasText:text !== undefined,textChars:text?.length ?? 0});
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
    frameRatesRef.current.reset();
    setFrameRates(frameRatesRef.current.read(performance.now()));
    setFramesPerSecondState(next);
    if (liveRef.current) {
      startFrameLoop();
    }
  }

  function handleServerPayload(raw: string) {
    // React may apply guidance updates after a later chunk closes this turn.
    const turnOpenOnReceipt = assistantTurnOpenRef.current;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      recordSessionFailure("malformed_message",false);
      setRecoverableError("Received malformed JSON from the gateway");
      cancelCaptions();
      setGuidance((current) => updateGuidance(current, { failed: true, turnOpen: turnOpenOnReceipt }));
      return;
    }

    const message = parseServerMessage(parsed);
    if (!message) {
      return;
    }

    if (message.type === "session.ended") {
      const currentId=feedbackRef.current.sessionId;
      const stoppingBeforeAcceptance=stoppingRef.current && endingRef.current !== null && currentId === null;
      if (!stoppingBeforeAcceptance && message.session_id !== currentId) return;
      recordEvidence("session_ended");
      if (endingRef.current) endingRef.current.resolve();
      else {
        finishEvidence("stopped");
        cleanupSession();
      }
      return;
    }

    if (stoppingRef.current) {
      return;
    }

    switch (message.type) {
      case "session.started":
        if (!liveRef.current) setSessionStartedAtMonotonicMs(performance.now());
        recordEvidence("session_accepted");
        setSessionConnection("accepted");
        setSessionActivity("idle");
        setPlaybackDiagnostics(emptyPlaybackDiagnostics());
        liveRef.current = true;
        feedbackRef.current = {...emptyInputFeedback(message.session_id),generation:micGenerationRef.current};
        setInputFeedback(feedbackRef.current);
        speechRef.current = message.speech ?? null;
        setSpeechCapabilities(speechRef.current);
        setSessionId(message.session_id);
        setPhase("live");
        setFatalError(null);
        setRecoverableError(null);
        startFrameLoop();
        void ensurePcmPlayer().resume();
        captionTimelineRef.current.cancel();
        if (captionTimerRef.current !== null) window.clearInterval(captionTimerRef.current);
        captionTimerRef.current = window.setInterval(refreshCaptions,50);
        break;
      case "input.transcription":
      case "input.status": {
        if (message.session_id !== feedbackRef.current.sessionId) break;
        const previousFeedback=feedbackRef.current;
        const eligible=canUpdateSessionActivity(previousFeedback,message);
        const nextFeedback=applyInputFeedback(message);
        const instructionAccepted=message.type === "input.transcription"
          ? nextFeedback !== previousFeedback && !!message.text.trim() && !previousFeedback.pendingId
            && message.turn_order >= (previousFeedback.acceptedInputOrder ?? 0)
          : (nextFeedback.acceptedInputOrder ?? 0) > (previousFeedback.acceptedInputOrder ?? 0);
        const inputOrdering={latestObservedOrder:nextFeedback.latestOrder,acceptedInputOrder:nextFeedback.acceptedInputOrder ?? 0,instructionAccepted};
        if (message.type === "input.status") {
          recordEvidence("input_status",{source:message.source,inputId:message.input_id,state:message.state,turnOrder:message.turn_order,generation:message.generation,accepted:eligible,...inputOrdering});
          if (eligible) {
            if (message.state === "preparing" || message.state === "sending") {
              const activity=message.state;
              setSessionActivity(current=>current === "responding" ? current : activity);
            }
            if (message.state === "waiting" || message.state === "sent") setSessionActivity(current=>current === "responding" ? current : "waiting");
            if (message.state === "failed") { recordSessionFailure("input_failed",false); setSessionActivity(current=>current === "responding" ? current : "idle"); }
            if (message.state === "cancelled") setSessionActivity(current=>current === "responding" ? current : "idle");
          }
        } else {
          recordEvidence("input_status",{source:"voice",inputId:message.utterance_id,state:"transcribing",final:message.final,revision:message.revision,turnOrder:message.turn_order,generation:message.generation,accepted:eligible,...inputOrdering,hasText:!!message.text.trim(),textChars:message.text.length});
          if ((eligible || (instructionAccepted && message.turn_order > lastReplyOrderRef.current)) && message.final && message.text.trim()) setSessionActivity(current=>current === "responding" ? current : "waiting");
          // ASR is a fallback, not a second interruption for the same question.
          // MiniCPM/JoyAI turn orders distinguish a new instruction from a late
          // transcription revision belonging to the answer already playing.
          if (instructionAccepted && message.turn_order > voiceInterruptOrderRef.current) {
            voiceInterruptOrderRef.current=message.turn_order;
            if (message.turn_order > lastReplyOrderRef.current && replyPlaybackActive()) interruptPlayback('input-transcription');
          }
        }
        if (eligible && message.type === 'input.status' && message.input_id === typedWaiterRef.current?.id) {
          if (message.state === 'waiting') { finishTyped(true); resetMicrophone(); }
          if (message.state === 'failed' || message.state === 'cancelled') {
            setRecoverableError(message.detail ?? 'Typed instruction was not sent');
            finishTyped(false);
            resetMicrophone();
          }
        }
        break;
      }
      case "response.chunk": {
        if (message.session_id !== feedbackRef.current.sessionId) break;
        if (message.diagnostic) {
          const diagnostic=message.diagnostic;
          const native=diagnostic.native;
          recordEvidence("diagnostic",{state:diagnostic.event,stage:diagnostic.stage,elapsed_ms:diagnostic.elapsed_ms,chunk_index:diagnostic.chunk_index,...diagnostic.input,...diagnostic.output,inputAudioMs:diagnostic.input.audio_ms,outputAudioMs:diagnostic.output.audio_ms,...diagnostic.speech,...diagnostic.metrics,
            ...(native ? {native_kind:native.kind,native_matched:native.matched,native_input_sequence:native.input_sequence,
              native_input_age_ms:native.input_age_ms,native_input_frames:native.input_frames,native_input_audio_ms:native.input_audio_ms,
              native_force_listen:native.force_listen,native_force_source:native.force_source,native_listen_events:native.listen_events,
              native_listen_streak:native.listen_streak,native_since_content_ms:native.since_content_ms} : {})});
          frameRatesRef.current.upstream(message.diagnostic.input.frames, performance.now());
          const entries = appendRuntimeDiagnostic(runtimeDiagnosticsRef.current, message.diagnostic, Date.now());
          if (entries !== runtimeDiagnosticsRef.current) {
            runtimeDiagnosticsRef.current = entries;
            setRuntimeDiagnostics(entries);
            console.debug('[MiniCPM diagnostic]', message.diagnostic);
          }
          // Telemetry must not open/end a turn, clear captions or change playback.
          if (!message.text && !message.raw && !message.audio && !message.final && !message.interrupted) break;
        }
        const chunk = message.text ?? "";
        const presentable = hasPresentableText(chunk);
        const rawChunk = message.raw ?? "";
        const presentableRaw = hasRawOutput(rawChunk);
        const inputChunk = inputTranscriptionFromRaw(rawChunk);
        const presentableInput = hasPresentableText(inputChunk);
        const feedback=feedbackRef.current;
        const pendingOrder=feedback.entries.find(entry=>entry.id === feedback.pendingId)?.turnOrder ?? 0;
        const acceptedInputOrder=feedback.acceptedInputOrder ?? 0;
        const orderIsCurrent=message.turn_order === undefined || message.turn_order >= Math.max(acceptedInputOrder,lastReplyOrderRef.current,pendingOrder);
        if (message.interrupted) {
          interruptPlayback('server',orderIsCurrent && turnOpenOnReceipt && !feedback.pendingId);
        } else if (presentableInput && replyPlaybackActive() && !suppressInputBargeInRef.current) {
          interruptPlayback('input-transcription');
        }
        // An onset can precede the first model chunk. Retain the speech level
        // so that output cannot slip through while the user is still talking.
        if ((presentable || message.audio) && microphoneSpeechActiveRef.current && !discardReplyAudioRef.current) {
          if (!message.final) assistantTurnOpenRef.current = true;
          interruptPlayback('microphone');
        }
        const replyIsCurrent=orderIsCurrent && !discardReplyAudioRef.current && !microphoneSpeechActiveRef.current && !message.interrupted;
        const dropReason=message.interrupted ? "server_interrupted" : !orderIsCurrent ? "stale_order"
          : microphoneSpeechActiveRef.current ? "microphone_active" : discardReplyAudioRef.current ? "interrupted_turn" : undefined;
        const replyDecision={accepted:replyIsCurrent,discarded:!replyIsCurrent,dropReason,latestObservedOrder:feedback.latestOrder,
          acceptedInputOrder,pendingInputOrder:pendingOrder,lastReplyOrder:lastReplyOrderRef.current};
        if (message.final || message.interrupted) {
          recordEvidence("response_boundary",{final:message.final,interrupted:message.interrupted,turnOrder:message.turn_order,...replyDecision});
        }
        if (chunk.length || message.audio) {
          // Counts only: preserve whitespace-only arrivals for boundary tracing
          // without retaining additional text or changing reply acceptance.
          recordEvidence("output",{textChars:chunk.length,leadingWhitespace:chunk.match(/^\s*/u)?.[0].length ?? 0,
            trailingWhitespace:chunk.match(/\s*$/u)?.[0].length ?? 0,whitespaceOnly:chunk.length > 0 && !presentable,
            caption_unit:message.caption_unit,final:message.final,interrupted:message.interrupted,turnOrder:message.turn_order,...replyDecision});
        }
        if (presentable || message.audio) {
          if (replyIsCurrent && !message.interrupted) setSessionActivity(message.final ? "idle" : "responding");
        } else if (message.final && !presentableInput && !message.diagnostic && replyIsCurrent && turnOpenOnReceipt && !feedback.pendingId) {
          setSessionActivity(current=>current === "responding" ? "idle" : current);
        }
        if ((presentable || message.audio) && replyIsCurrent && !message.interrupted) {
          if (message.turn_order !== undefined) lastReplyOrderRef.current=message.turn_order;
          applyInputFeedback({type:'assistant',turn_order:message.turn_order ?? (turnOpenOnReceipt ? feedback.latestOrder : undefined)});
        }

        if (presentableInput) {
          suppressInputBargeInRef.current = true;
        }
        if (replyIsCurrent && chunk.length) captionTimelineRef.current.addText(chunk,message.caption_unit,performance.now());
        if (message.audio) {
          const interval=playReplyAudio(message.audio, replyIsCurrent, message.caption_unit);
          if (replyIsCurrent) captionTimelineRef.current.schedule(message.caption_unit,interval,performance.now());
        }
        if ((message.audio || presentable) && !message.final) {
          assistantTurnOpenRef.current = true;
        }
        if (presentable && replyIsCurrent) {
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

        // A streamed word boundary can arrive as its own whitespace-only chunk.
        if (replyIsCurrent && (presentable || (chunk.length > 0 && streamingAssistantIdRef.current))) {
          const streamingId = streamingAssistantIdRef.current;
          if (streamingId) {
            setMessages((current) =>
              current.map((entry) =>
                entry.id === streamingId
                  ? {
                      ...entry,
                      text: `${entry.text}${chunk}`,
                      streaming: !message.final,
                      ...(message.final ? {endReason:"model_final" as const} : {}),
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
                turnOrder: message.turn_order,
                text: chunk,
                streaming: !message.final,
                ...(message.final ? {endReason:"model_final" as const} : {}),
              },
            ]);
          }
        } else if (streamingAssistantIdRef.current && message.final) {
          const streamingId = streamingAssistantIdRef.current;
          setMessages((current) =>
            current.map((entry) => (entry.id === streamingId ? { ...entry, streaming: false, ...(replyIsCurrent ? {endReason:"model_final" as const} : {}) } : entry))
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
          if (replyIsCurrent) captionTimelineRef.current.finish(performance.now());
        }

        refreshCaptions();

        setIsStreaming(replyIsCurrent && !message.final);
        break;
      }
      case "error":
        cancelCaptions("failure");
        recordSessionFailure(safeFailureReason(message.message),message.fatal);
        if (typedWaiterRef.current) {
          applyInputFeedback({type:'input.status',session_id:feedbackRef.current.sessionId ?? '',input_id:typedWaiterRef.current.id,
            source:'typed',turn_order:feedbackRef.current.latestOrder,state:'failed',detail:message.message});
          finishTyped(false);
          setSessionActivity(current=>current === "responding" ? current : "idle");
        }
        setGuidance((current) => updateGuidance(current, { failed: true, turnOpen: turnOpenOnReceipt }));
        if (message.fatal) {
          setFatalError(overloadRecoveryMessage(message.message));
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

  // A session has no source identity in the protocol. Stop it on replacement so
  // replies already in flight cannot be presented over a different video.
  function invalidateSourceSession() {
    cancelCaptions();
    if (phase !== "idle") {
      void endSession();
      setSessionNotice("Video source changed. Start a new session to receive assistance for this source.");
    }
  }

  function disableCamera() {
    invalidateSourceSession();
    cameraRequestIdRef.current += 1;
    cameraInFlightRef.current = false;
    stopVideoPreview();
    setCameraOn(false);
    setCameraError(null);
    setCameraView("empty");
    applyVideoSource("none");
  }

  async function enableCamera(deviceId: string) {
    invalidateSourceSession();
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
    invalidateSourceSession();
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
    invalidateSourceSession();
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
    invalidateSourceSession();
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
    if (evidenceRef.current) {
      recordCaptionClear("session_ended");
      evidenceRef.current.finish("replaced");
      archiveCompletedEvidence(evidenceRef.current);
    }
    evidenceRef.current=new SessionEvidence(selectedModelIdRef.current,Date.now(),performance.now(),undefined,includeTranscript);
    evidencePublishedAtRef.current=-Infinity;
    microphoneSentRef.current=false;
    recordEvidence("start");
    recordClientConfiguration();
    setSessionConnection("connecting");
    setSessionActivity("idle");
    setFatalError(null);
    setRecoverableError(null);
    setMessages([]);
    setGuidance(null);
    setSessionNotice(null);
    setDebugEntries([]);
    runtimeDiagnosticsRef.current = [];
    setRuntimeDiagnostics([]);
    setIsStreaming(false);
    setPhase("connecting");
    setSessionStartedAtMonotonicMs(null);
    frameRatesRef.current.reset();
    setFrameRates(frameRatesRef.current.read(performance.now()));

    if (parseGatewayAddress(serverAddressRef.current) !== fetchedOriginRef.current) {
      await loadCatalog();
    }
    if (generation !== generationRef.current) {
      return;
    }
    if (parseGatewayAddress(serverAddressRef.current) !== fetchedOriginRef.current) {
      recordSessionFailure("startup_failed");
      setPhase("idle");
      return;
    }

    const model = selectedModelRef.current;
    const sessionConfig = { ...configRef.current };
    if (!model) {
      recordSessionFailure("startup_failed");
      setPhase("idle");
      return;
    }

    if (Object.keys(generationConfigErrors(model.id, model.config_schema, sessionConfig)).length) {
      recordSessionFailure("startup_failed");
      setFatalError("Check the values in Advanced generation before starting.");
      cleanupSession();
      return;
    }
    const requestedGeneration = generationEvidence(model.id, model.config_schema, sessionConfig);
    if (requestedGeneration) recordEvidence("generation_config", requestedGeneration);
    recordEvidence("client_config", {customPromptPresent:typeof sessionConfig.system_prompt === "string" && sessionConfig.system_prompt.trim().length > 0});

    let socket:WebSocket;
    try {
      stopPcmPlayer();
      const player = createPcmPlayer();
      pcmPlayerRef.current = player;
      void player.resume();
      socket = new WebSocket(getRealtimeUrl(serverAddressRef.current));
    } catch {
      recordSessionFailure("startup_failed");
      setFatalError("Could not start the session. Check the connection and try a fresh session.");
      cleanupSession();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      if (generation !== generationRef.current || stoppingRef.current) {
        return;
      }
      recordEvidence("socket_open");
      setSessionConnection("socket");
      try { socket.send(
        encodeClientMessage({
          type: "session.start",
          model: model.id,
          config: sessionConfig,
        })
      ); } catch {
        recordSessionFailure("send_failed");
        setFatalError("The session request could not be sent. Try a fresh session.");
        cleanupSession();
      }
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
      recordSessionFailure("socket_error");
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
      recordSessionFailure("socket_closed");
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
    const generation=generationRef.current;
    stoppingRef.current = true;
    setGuidance(null);
    setRecoverableError(null);
    // Preserve an earlier terminal failure (including typed timeout) through cleanup.
    stopFrameTimer();
    liveRef.current = false;
    audio.cancelCapture();
    stopPcmPlayer("session_ended");

    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      finishEvidence("stopped");
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
      if (generation === generationRef.current) finishEvidence("stopped");
    } catch (error) {
      if (generation === generationRef.current) {
        recordSessionFailure("stop_failed");
        setFatalError(error instanceof Error ? error.message : "Session end failed");
      }
    } finally {
      clearWaiter?.();
      // Unmount owns its cleanup; a rejected old waiter must not relabel or export it.
      if (generation === generationRef.current) {
        generationRef.current += 1;
        closeSocket();
        resetTransientState();
        stoppingRef.current = false;
      }
    }
  }

  async function sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    const inputPolicy = typedInputPolicy(selectedModelIdRef.current, liveRef.current, speechRef.current, feedbackRef.current.busy);
    if (!inputPolicy.enabled) {
      setRecoverableError(inputPolicy.notice ?? "Start a Session before sending a message");
      return false;
    }
    const nativeJoyInput = selectedModelIdRef.current === 'joyai-vl' && speechRef.current?.typed_input === true;
    if (selectedModelIdRef.current === 'minicpm-o-4-5' || nativeJoyInput) {
      if (nativeJoyInput && !sourceLiveRef.current) {
        setRecoverableError('Turn on the camera or choose a video before sending a JoyAI instruction');
        return false;
      }
      if (Array.from(text).length > 500 || /[\uD800-\uDFFF]/u.test(text)) {
        setRecoverableError('Use 1–500 characters for a typed instruction');
        return false;
      }
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return false;
      const id = crypto.randomUUID();
      interruptPlayback();
      resetMicrophone();
      applyInputFeedback({type:'typed',input_id:id,text,transport:nativeJoyInput ? 'text' : 'speech'});
      recordEvidence("input",{source:"typed",inputId:id,textChars:text.length});
      setSessionActivity(nativeJoyInput ? "sending" : "preparing");
      setRecoverableError(null);
      const sent = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          if (typedWaiterRef.current?.id !== id) return;
          finishTyped(false);
          recordSessionFailure("typed_timeout");
          setFatalError('Typed instruction timed out. Start a new session before retrying.');
          void endSession();
        }, 70_000);
        typedWaiterRef.current = {id,resolve,timer};
      });
      try { socket.send(encodeClientMessage({type:'input.typed',request_id:id,text})); }
      catch {
        recordSessionFailure("send_failed");
        setFatalError("The instruction could not be sent. Start a fresh session before retrying.");
        finishTyped(false); cleanupSession();
      }
      return sent;
    }
    interruptPlayback();
    let accepted = false;
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
      setSessionActivity("waiting");
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
      accepted = true;
    });
    return accepted;
  }

  useEffect(() => {
    archiveMountedRef.current=true;
    void archiveRef.current?.load();
    return ()=>{archiveMountedRef.current=false;};
  }, []);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      cameraRequestIdRef.current += 1;
      fileRequestIdRef.current += 1;
      endingRef.current?.reject(new Error("unmounted"));
      recordCaptionClear("session_ended");
      pcmPlayerRef.current?.stop("closed");
      evidenceRef.current?.finish("unmounted");
      if (evidenceRef.current) archiveCompletedEvidence(evidenceRef.current);
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

  useEffect(() => {
    if (phase === "live") recordClientConfiguration();
    // Record only changes to these browser settings, not every diagnostic render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, framesPerSecond, audio.mode, audio.enabled, audio.videoAudioSelected, videoSource, captionsEnabled]);

  useEffect(() => {
    if (phase !== "live") return;
    const timer = window.setInterval(() => setFrameRates(frameRatesRef.current.read(performance.now())), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const generationValid = useMemo(() => !selectedModel ||
    Object.keys(generationConfigErrors(selectedModel.id, selectedModel.config_schema, config)).length === 0,
  [selectedModel, config]);
  const sessionActive = phase !== "idle";
  const sessionStatusView = describeSessionStatusView({phase,connection:sessionConnection,activity:sessionActivity,mode:audio.mode,holding:audio.holding,listening:audio.listening,pending:audio.pending,micError:Boolean(audio.error),speaking:microphoneSpeechActive,watching:(frameRates.submitted ?? 0) > 0});

  return {
    catalogStatus,
    catalogError,
    models,
    selectedModelId,
    config,
    serverAddress,
    framesPerSecond,
    frameRates,
    modelMuted,
    modelVolume,
    setModelVolume,
    captionsEnabled,
    captionSize,
    setCaptionSize,
    captionBackgroundOpacity,
    setCaptionBackgroundOpacity,
    resetCaptionAppearance,
    toggleCaptions: () => {
      captionsEnabledRef.current = !captionsEnabledRef.current;
      setCaptionsEnabled(captionsEnabledRef.current);
      writePreference("captionsEnabled", captionsEnabledRef.current);
    },
    toggleModelMuted: () => {
      if (modelVolumeRef.current === 0) {
        setModelVolume(lastAudibleVolumeRef.current);
        return;
      }
      modelMutedRef.current = !modelMutedRef.current;
      setModelMuted(modelMutedRef.current);
      if (modelMutedRef.current) captionTimelineRef.current.mute(pcmPlayerRef.current?.clockTime() ?? 0,performance.now());
      pcmPlayerRef.current?.setMuted(modelMutedRef.current);
    },
    selectedModel,
    phase,
    sessionId,
    sessionStartedAtMonotonicMs,
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
      beginHold: () => {
        microphoneSentRef.current=false;
        audio.beginHold();
      },
      endHold: () => {
        const held=audio.holding;
        audio.endHold();
        if (held && microphoneSentRef.current && liveRef.current) {
          recordEvidence("input_status",{source:"microphone",state:"waiting"});
          setSessionActivity(current=>current === "responding" ? current : "waiting");
        }
      },
      toggle: () => {
        void pcmPlayerRef.current?.resume();
        audio.toggle();
      },
    },
    devices,
    messages,
    guidance,
    inputCaption: inputFeedback.caption,
    inputStatus: inputFeedback.status,
    typedBusy: inputFeedback.busy,
    speechCapabilities,
    sessionNotice,
    sessionStatus:sessionStatusView.detail,
    sessionStatusBadge:sessionStatusView,
    sessionLogSummary,
    markSessionIssue:()=>{ if (liveRef.current && !stoppingRef.current) recordEvidence("issue"); },
    markSessionStateChange:()=>markStateChangeRef.current("button"),
    stateChangeShortcutHeld,
    downloadSessionLog,
    savedSessionLogs,
    includeTranscript,
    setIncludeTranscript:(enabled:boolean)=>{if (phase === "idle") setIncludeTranscript(enabled);},
    savedLogDownloadStatus,
    downloadSavedSessionLog,
    clearSavedSessionLogs,
    debugEntries,
    playbackDiagnostics,
    runtimeDiagnostics,
    isStreaming,
    sessionActive,
    canStart: catalogStatus === "ready" && Boolean(selectedModel) && phase === "idle" && generationValid,
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

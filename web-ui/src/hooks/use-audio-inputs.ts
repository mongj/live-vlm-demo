"use client";

import { AudioMixer, type MixerSource } from "@/lib/audio-mixer";
import { readPreference, writePreference, type MicrophoneMode } from "@/lib/playground-preferences";
import {
  assertSecureMediaContext,
  DEFAULT_DEVICE_ID,
  mediaDeviceErrorMessage,
  microphoneConstraints,
  stopMediaStream,
} from "@/lib/media-devices";
import { useEffect, useRef, useState } from "react";

export const VIDEO_AUDIO_SOURCE_ID = "video";
export const DEFAULT_SOURCE_GAIN = 1;
export const MAX_SOURCE_GAIN = 2;

export function microphoneSourceId(deviceId: string): string {
  return `microphone:${deviceId}`;
}

type MicrophoneStreams = Readonly<Record<string, MediaStream>>;

type AudioInputsOptions = {
  /** True while a Session is live; the mixer only runs then. */
  capturing: boolean;
  videoAudioStream: MediaStream | null;
  onChunk: (pcm: Uint8Array) => void;
  onSpeechStart: () => void;
  onPermissionGranted: () => void;
  onMicrophoneChunk?: (pcm: Uint8Array) => void;
  onMicrophoneReset?: () => void;
};

export type AudioInputsState = {
  mode: MicrophoneMode;
  holding: boolean;
  listening: boolean;
  setMode: (mode: MicrophoneMode) => void;
  beginHold: () => void;
  endHold: () => void;
  cancelHold: () => void;
  cancelCapture: () => void;
  enabled: boolean;
  pending: boolean;
  error: string | null;
  selectedMicrophoneIds: string[];
  videoAudioAvailable: boolean;
  videoAudioSelected: boolean;
  gains: Readonly<Record<string, number>>;
  outputDeviceId: string;
  toggle: () => void;
  toggleMicrophone: (deviceId: string) => void;
  setVideoAudioSelected: (selected: boolean) => void;
  setGain: (sourceId: string, gain: number) => void;
  setOutputDeviceId: (deviceId: string) => void;
};

function mixerSources(
  microphones: MicrophoneStreams,
  videoAudio: MediaStream | null,
  gains: Readonly<Record<string, number>>
): Map<string, MixerSource> {
  const sources = new Map<string, MixerSource>();
  for (const [deviceId, stream] of Object.entries(microphones)) {
    const id = microphoneSourceId(deviceId);
    sources.set(id, { stream, kind: "microphone", gain: gains[id] ?? DEFAULT_SOURCE_GAIN });
  }
  if (videoAudio) {
    sources.set(VIDEO_AUDIO_SOURCE_ID, {
      stream: videoAudio,
      kind: "media",
      gain: gains[VIDEO_AUDIO_SOURCE_ID] ?? DEFAULT_SOURCE_GAIN,
    });
  }
  return sources;
}

export function useAudioInputs({
  capturing,
  videoAudioStream,
  onChunk,
  onSpeechStart,
  onPermissionGranted,
  onMicrophoneChunk,
  onMicrophoneReset,
}: AudioInputsOptions): AudioInputsState {
  const [enabled, setEnabled] = useState(false);
  const [mode, setModeState] = useState<MicrophoneMode>("push-to-talk");
  const [holding, setHolding] = useState(false);
  const enabledRef = useRef(false);
  const modeRef = useRef(mode);
  const modePreferenceLoadedRef = useRef(false);
  const holdingRef = useRef(false);
  const capturingRef = useRef(capturing);
  capturingRef.current = capturing;
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedMicrophoneIds, setSelectedMicrophoneIds] = useState<string[]>([DEFAULT_DEVICE_ID]);
  const [microphones, setMicrophones] = useState<MicrophoneStreams>({});
  const [videoAudioSelected, setVideoAudioSelected] = useState(true);
  const [gains, setGains] = useState<Readonly<Record<string, number>>>({});
  const [outputDeviceId, setOutputDeviceId] = useState(DEFAULT_DEVICE_ID);
  const generationRef = useRef(0);
  const selectedRef = useRef(selectedMicrophoneIds);
  const microphonesRef = useRef<MicrophoneStreams>({});
  const mixerRef = useRef<AudioMixer | null>(null);
  const sourceSettingsRef = useRef({videoAudioStream, videoAudioSelected, gains});
  sourceSettingsRef.current = {videoAudioStream, videoAudioSelected, gains};
  const callbacksRef = useRef({ onChunk, onSpeechStart, onPermissionGranted, onMicrophoneChunk, onMicrophoneReset });

  useEffect(() => {
    if (modePreferenceLoadedRef.current) return;
    modePreferenceLoadedRef.current = true;
    const savedMode = readPreference("microphoneMode");
    modeRef.current = savedMode;
    // Hydrating a choice never arms the microphone or requests media permission.
    setModeState(savedMode);
  }, []);

  useEffect(() => {
    callbacksRef.current = { onChunk, onSpeechStart, onPermissionGranted, onMicrophoneChunk, onMicrophoneReset };
  });

  function updateMicrophones(next: MicrophoneStreams) {
    microphonesRef.current = next;
    setMicrophones(next);
  }

  function releaseMicrophone(deviceId: string) {
    if (!microphonesRef.current[deviceId]) return;
    cancelMicrophone();
  }

  function releaseAllMicrophones() {
    for (const stream of Object.values(microphonesRef.current)) {
      stopMediaStream(stream);
    }
    updateMicrophones({});
  }

  async function acquireMicrophone(deviceId: string) {
    const generation = generationRef.current;
    setPendingCount((count) => count + 1);
    try {
      assertSecureMediaContext("microphone");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: microphoneConstraints(deviceId),
        video: false,
      });
      const stale =
        generation !== generationRef.current ||
        !wantsMicrophone() ||
        !selectedRef.current.includes(deviceId) ||
        Boolean(microphonesRef.current[deviceId]);
      if (stale) {
        stopMediaStream(stream);
        return;
      }
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", () => {
          if (microphonesRef.current[deviceId] === stream) {
            releaseMicrophone(deviceId);
          }
        });
      }
      updateMicrophones({ ...microphonesRef.current, [deviceId]: stream });
      callbacksRef.current.onPermissionGranted();
    } catch (acquireError) {
      if (generation === generationRef.current) {
        setError(mediaDeviceErrorMessage(acquireError, "microphone"));
      }
    } finally {
      setPendingCount((count) => count - 1);
    }
  }

  function enable() {
    generationRef.current += 1;
    setEnabled(true);
    enabledRef.current = true;
    setError(null);
    if (wantsMicrophone()) for (const deviceId of selectedRef.current) void acquireMicrophone(deviceId);
  }

  function disable() {
    generationRef.current += 1;
    setEnabled(false);
    enabledRef.current = false;
    setError(null);
    cancelMicrophone();
  }

  function wantsMicrophone() {
    return enabledRef.current && capturingRef.current &&
      (modeRef.current === "always-listening" || holdingRef.current);
  }

  function detachMicrophones() {
    const current = sourceSettingsRef.current;
    const library = current.videoAudioSelected ? current.videoAudioStream : null;
    mixerRef.current?.setSources(mixerSources({}, library, current.gains));
    releaseAllMicrophones();
  }

  function cancelMicrophone() {
    generationRef.current += 1;
    holdingRef.current = false;
    setHolding(false);
    callbacksRef.current.onMicrophoneReset?.();
    detachMicrophones();
  }

  function beginHold() {
    if (modeRef.current !== "push-to-talk" || !capturingRef.current || holdingRef.current) return;
    // The press itself interrupts, before permission or a speech-onset decision.
    callbacksRef.current.onSpeechStart();
    holdingRef.current = true;
    enabledRef.current = true;
    setEnabled(true);
    setHolding(true);
    setError(null);
    generationRef.current += 1;
    for (const id of selectedRef.current) void acquireMicrophone(id);
  }

  function endHold() {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    generationRef.current += 1;
    mixerRef.current?.finishMicrophone();
    detachMicrophones();
  }

  function setMode(next: MicrophoneMode) {
    if (next !== "always-listening" && next !== "push-to-talk") return;
    if (next === modeRef.current) return;
    modePreferenceLoadedRef.current = true;
    writePreference("microphoneMode", next);
    cancelMicrophone();
    modeRef.current = next;
    setModeState(next);
    if (wantsMicrophone()) for (const id of selectedRef.current) void acquireMicrophone(id);
  }

  function toggleMicrophone(deviceId: string) {
    const selected = selectedRef.current.includes(deviceId);
    const next = selected
      ? selectedRef.current.filter((id) => id !== deviceId)
      : [...selectedRef.current, deviceId];
    selectedRef.current = next;
    setSelectedMicrophoneIds(next);
    cancelMicrophone();
    if (!wantsMicrophone()) {
      return;
    }
    for (const id of next) void acquireMicrophone(id);
  }

  /* eslint-disable react-hooks/set-state-in-effect -- session capture lifecycle must publish stopped hardware state */
  useEffect(() => {
    if (!capturing) {
      generationRef.current += 1;
      holdingRef.current = false;
      setHolding(false);
      callbacksRef.current.onMicrophoneReset?.();
      for (const stream of Object.values(microphonesRef.current)) stopMediaStream(stream);
      microphonesRef.current = {};
      setMicrophones({});
      mixerRef.current?.stop();
      mixerRef.current = null;
      return;
    }
    if (!mixerRef.current) {
      const created = new AudioMixer(
        (pcm) => callbacksRef.current.onChunk(pcm),
        () => callbacksRef.current.onSpeechStart(),
        (pcm) => callbacksRef.current.onMicrophoneChunk?.(pcm)
      );
      mixerRef.current = created;
      created.start().catch(() => {
        if (mixerRef.current === created) {
          setError("Audio capture could not start");
        }
      });
    }
    if (enabledRef.current && modeRef.current === "always-listening") {
      for (const id of selectedRef.current) if (!microphonesRef.current[id]) void acquireMicrophone(id);
    }
    // Source/gain changes do not cancel the ASR epoch, and library audio does
    // not depend on whether a push-to-talk microphone is held.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- acquisition is tied to session transitions
  }, [capturing]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    mixerRef.current?.setSources(mixerSources(microphones, videoAudioSelected ? videoAudioStream : null, gains));
  }, [microphones, videoAudioSelected, videoAudioStream, gains, capturing]);

  useEffect(() => {
    const cancel = () => { if (holdingRef.current) cancelMicrophone(); };
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers use current ownership refs
  }, []);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      mixerRef.current?.stop();
      mixerRef.current = null;
      for (const stream of Object.values(microphonesRef.current)) {
        stopMediaStream(stream);
      }
      microphonesRef.current = {};
    };
  }, []);

  return {
    mode,
    holding,
    listening: capturing && Object.keys(microphones).length > 0,
    setMode,
    beginHold,
    endHold,
    cancelHold: () => { if (holdingRef.current) cancelMicrophone(); },
    cancelCapture: cancelMicrophone,
    enabled,
    pending: pendingCount > 0,
    error,
    selectedMicrophoneIds,
    videoAudioAvailable: videoAudioStream !== null,
    videoAudioSelected,
    gains,
    outputDeviceId,
    toggle: () => {
      if (enabled) {
        disable();
      } else {
        enable();
      }
    },
    toggleMicrophone,
    setVideoAudioSelected,
    setGain: (sourceId, gain) => {
      const clamped = Math.min(MAX_SOURCE_GAIN, Math.max(0, gain));
      setGains((current) => ({ ...current, [sourceId]: clamped }));
    },
    setOutputDeviceId,
  };
}

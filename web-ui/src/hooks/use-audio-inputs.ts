"use client";

import { AudioMixer, type MixerSource } from "@/lib/audio-mixer";
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
};

export type AudioInputsState = {
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
}: AudioInputsOptions): AudioInputsState {
  const [enabled, setEnabled] = useState(false);
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
  const callbacksRef = useRef({ onChunk, onSpeechStart, onPermissionGranted });

  useEffect(() => {
    callbacksRef.current = { onChunk, onSpeechStart, onPermissionGranted };
  });

  function updateMicrophones(next: MicrophoneStreams) {
    microphonesRef.current = next;
    setMicrophones(next);
  }

  function releaseMicrophone(deviceId: string) {
    const stream = microphonesRef.current[deviceId];
    if (!stream) {
      return;
    }
    stopMediaStream(stream);
    const next = { ...microphonesRef.current };
    delete next[deviceId];
    updateMicrophones(next);
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
    setError(null);
    for (const deviceId of selectedRef.current) {
      void acquireMicrophone(deviceId);
    }
  }

  function disable() {
    generationRef.current += 1;
    setEnabled(false);
    setError(null);
    releaseAllMicrophones();
  }

  function toggleMicrophone(deviceId: string) {
    const selected = selectedRef.current.includes(deviceId);
    const next = selected
      ? selectedRef.current.filter((id) => id !== deviceId)
      : [...selectedRef.current, deviceId];
    selectedRef.current = next;
    setSelectedMicrophoneIds(next);
    if (!enabled) {
      return;
    }
    if (selected) {
      releaseMicrophone(deviceId);
    } else {
      void acquireMicrophone(deviceId);
    }
  }

  useEffect(() => {
    if (!capturing || !enabled) {
      mixerRef.current?.stop();
      mixerRef.current = null;
      return;
    }
    let mixer = mixerRef.current;
    if (!mixer) {
      const created = new AudioMixer(
        (pcm) => callbacksRef.current.onChunk(pcm),
        () => callbacksRef.current.onSpeechStart()
      );
      mixerRef.current = created;
      created.start().catch(() => {
        if (mixerRef.current === created) {
          setError("Audio capture could not start");
        }
      });
      mixer = created;
    }
    mixer.setSources(mixerSources(microphones, videoAudioSelected ? videoAudioStream : null, gains));
  }, [capturing, enabled, microphones, videoAudioSelected, videoAudioStream, gains]);

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

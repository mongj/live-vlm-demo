"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/** Positions this close to the end count as finished, so play restarts from the beginning. */
const END_TOLERANCE_SECONDS = 0.1;
const MEDIA_EVENTS = [
  "durationchange",
  "emptied",
  "ended",
  "loadedmetadata",
  "pause",
  "play",
  "seeked",
  "timeupdate",
] as const;

export type VideoPlaybackState = {
  paused: boolean;
  /** Scrub position while dragging, otherwise the element's current time. */
  currentTime: number;
  /** Null while the container has not reported a finite duration. */
  duration: number | null;
  scrubbing: boolean;
  togglePlay: () => void;
  skipToStart: () => void;
  skipToEnd: () => void;
  /** Starts a pointer drag; it ends on the next window pointerup or pointercancel. */
  beginScrub: () => void;
  /** Previews `time` during a drag, or seeks straight there otherwise (e.g. keyboard). */
  scrubTo: (time: number) => void;
};

function finiteDuration(video: HTMLVideoElement): number | null {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
}

function atEnd(video: HTMLVideoElement): boolean {
  const duration = finiteDuration(video);
  return video.ended || (duration !== null && video.currentTime >= duration - END_TOLERANCE_SECONDS);
}

export function useVideoPlayback(videoRef: RefObject<HTMLVideoElement | null>): VideoPlaybackState {
  const [paused, setPaused] = useState(true);
  const [elementTime, setElementTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const scrubbingRef = useRef(false);
  const scrubTimeRef = useRef<number | null>(null);
  const resumeAfterScrubRef = useRef(false);
  const probingDurationRef = useRef(false);
  const resumeAfterProbeRef = useRef(false);
  const endScrubRef = useRef(() => {});

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const sync = () => {
      const known = finiteDuration(video);
      if (known === null && video.duration === Infinity && !probingDurationRef.current) {
        // MediaRecorder WebM files report Infinity until the browser scans to the end.
        probingDurationRef.current = true;
        resumeAfterProbeRef.current = !video.paused;
        video.currentTime = Number.MAX_SAFE_INTEGER;
        return;
      }
      if (probingDurationRef.current) {
        if (known === null) {
          return;
        }
        probingDurationRef.current = false;
        video.currentTime = 0;
        // The probe seeks past the end, which pauses a non-looping element.
        if (resumeAfterProbeRef.current) {
          void video.play().catch(() => undefined);
        }
      }
      setDuration(known);
      setPaused(video.paused);
      setElementTime(video.currentTime);
    };
    for (const type of MEDIA_EVENTS) {
      video.addEventListener(type, sync);
    }
    sync();
    return () => {
      for (const type of MEDIA_EVENTS) {
        video.removeEventListener(type, sync);
      }
      probingDurationRef.current = false;
    };
  }, [videoRef]);

  function play(video: HTMLVideoElement) {
    if (atEnd(video)) {
      video.currentTime = 0;
    }
    void video.play().catch(() => undefined);
  }

  function withVideo(action: (video: HTMLVideoElement) => void) {
    const video = videoRef.current;
    if (video) {
      action(video);
    }
  }

  function seek(video: HTMLVideoElement, time: number) {
    video.currentTime = time;
    setElementTime(time);
  }

  function endScrub() {
    if (!scrubbingRef.current) {
      return;
    }
    scrubbingRef.current = false;
    const time = scrubTimeRef.current;
    scrubTimeRef.current = null;
    setScrubTime(null);
    withVideo((video) => {
      if (time !== null) {
        seek(video, time);
      }
      if (resumeAfterScrubRef.current) {
        play(video);
      }
    });
    resumeAfterScrubRef.current = false;
  }

  useEffect(() => {
    endScrubRef.current = endScrub;
  });

  useEffect(() => {
    const onPointerEnd = () => endScrubRef.current();
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, []);

  return {
    paused,
    currentTime: scrubTime ?? elementTime,
    duration,
    scrubbing: scrubTime !== null,
    togglePlay: () =>
      withVideo((video) => {
        if (video.paused) {
          play(video);
        } else {
          video.pause();
        }
      }),
    skipToStart: () =>
      withVideo((video) => {
        video.currentTime = 0;
      }),
    skipToEnd: () =>
      withVideo((video) => {
        const known = finiteDuration(video);
        if (known === null) {
          return;
        }
        video.pause();
        video.currentTime = known;
      }),
    beginScrub: () =>
      withVideo((video) => {
        if (scrubbingRef.current) {
          return;
        }
        scrubbingRef.current = true;
        resumeAfterScrubRef.current = !video.paused;
        video.pause();
      }),
    scrubTo: (time) =>
      withVideo((video) => {
        if (!scrubbingRef.current) {
          seek(video, time);
          return;
        }
        scrubTimeRef.current = time;
        setScrubTime(time);
        // Skipping seeks while one is pending keeps dragging smooth on files without seek cues.
        if (!video.seeking) {
          video.currentTime = time;
        }
      }),
  };
}

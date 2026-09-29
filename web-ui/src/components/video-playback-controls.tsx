"use client";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVideoPlayback } from "@/hooks/use-video-playback";
import { cn } from "@/lib/utils";
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";

const IDLE_HIDE_MS = 2500;
const SLIDER_STEPS_PER_SECOND = 100;

type VideoPlaybackControlsProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
};

/** Pointer position over the timeline, in px relative to the timeline wrapper. */
type TimelineHover = {
  fraction: number;
  trackLeft: number;
  trackWidth: number;
  trackCenter: number;
  bubbleLeft: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function isSpaceShortcut(event: KeyboardEvent): boolean {
  return (
    event.code === "Space" &&
    !event.repeat &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.target === document.body
  );
}

function ControlButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="text-white hover:bg-white/15 hover:text-white focus-visible:ring-white/50"
          onClick={onClick}
          size="icon"
          type="button"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** YouTube-style overlay for library videos: shown while paused, on pointer activity, or with keyboard focus. */
export function VideoPlaybackControls({ videoRef }: VideoPlaybackControlsProps) {
  const playback = useVideoPlayback(videoRef);
  const [pointerActive, setPointerActive] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const pressedLayerRef = useRef(false);
  const togglePlayRef = useRef(playback.togglePlay);
  const visible = playback.paused || pointerActive || playback.scrubbing;
  const [timelineHover, setTimelineHover] = useState<TimelineHover | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const playLabel = playback.paused ? "Play" : "Pause";
  const { duration } = playback;
  const currentFraction = duration === null ? 0 : clamp(playback.currentTime / duration, 0, 1);

  useEffect(() => {
    togglePlayRef.current = playback.togglePlay;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpaceShortcut(event)) {
        return;
      }
      event.preventDefault();
      togglePlayRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  function clearHideTimer() {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }

  function revealOnActivity() {
    setPointerActive(true);
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setPointerActive(false);
    }, IDLE_HIDE_MS);
  }

  function hideOnLeave() {
    clearHideTimer();
    setPointerActive(false);
  }

  function trackTimelineHover(event: PointerEvent<HTMLDivElement>) {
    const timeline = timelineRef.current;
    const track = timeline?.querySelector("[data-slot=slider-track]");
    if (!timeline || !track || duration === null) {
      return;
    }
    const bounds = timeline.getBoundingClientRect();
    const trackBounds = track.getBoundingClientRect();
    if (trackBounds.width <= 0) {
      return;
    }
    const fraction = clamp((event.clientX - trackBounds.left) / trackBounds.width, 0, 1);
    const trackLeft = trackBounds.left - bounds.left;
    const halfBubble = (bubbleRef.current?.offsetWidth ?? 0) / 2;
    setTimelineHover({
      fraction,
      trackLeft,
      trackWidth: trackBounds.width,
      trackCenter: trackBounds.top - bounds.top + trackBounds.height / 2,
      bubbleLeft: clamp(trackLeft + fraction * trackBounds.width, halfBubble, bounds.width - halfBubble),
    });
  }

  function handleLayerPointerDown(event: PointerEvent<HTMLDivElement>) {
    pressedLayerRef.current = event.target === event.currentTarget;
  }

  function handleLayerClick() {
    if (pressedLayerRef.current) {
      playback.togglePlay();
    }
    pressedLayerRef.current = false;
  }

  return (
    <div
      className={cn("absolute inset-0 z-20", !visible && "cursor-none")}
      data-slot="playback-overlay"
      data-visible={visible}
      onClick={handleLayerClick}
      onPointerDown={handleLayerPointerDown}
      onPointerLeave={hideOnLeave}
      onPointerMove={revealOnActivity}
    >
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-linear-to-t from-black/75 via-black/40 to-transparent px-3 pt-10 pb-2 text-white transition-opacity duration-200 has-focus-visible:opacity-100",
          visible ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      >
        <div
          className="relative"
          onPointerLeave={() => setTimelineHover(null)}
          onPointerMove={trackTimelineHover}
          ref={timelineRef}
        >
          {duration !== null && timelineHover && timelineHover.fraction > currentFraction ? (
            <div
              aria-hidden
              className="pointer-events-none absolute h-1.5 -translate-y-1/2 bg-white/40"
              style={{
                left: timelineHover.trackLeft + currentFraction * timelineHover.trackWidth,
                top: timelineHover.trackCenter,
                width: (timelineHover.fraction - currentFraction) * timelineHover.trackWidth,
              }}
            />
          ) : null}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-full bg-black/80 px-2.5 py-1 text-xs whitespace-nowrap text-white tabular-nums",
              (duration === null || !timelineHover) && "invisible"
            )}
            ref={bubbleRef}
            style={{ left: timelineHover?.bubbleLeft ?? 0 }}
          >
            {formatTime((timelineHover?.fraction ?? 0) * (duration ?? 0))}
          </div>
          <Slider
            aria-label="Seek"
            className={cn(
              "cursor-pointer data-disabled:cursor-default",
              "py-1.5 **:data-[slot=slider-range]:bg-white",
              "**:data-[slot=slider-track]:bg-white/30 **:data-[slot=slider-track]:transition-[height] **:data-[slot=slider-track]:duration-150",
              "**:data-[slot=slider-thumb]:border-white/40 **:data-[slot=slider-thumb]:ring-white/25 **:data-[slot=slider-thumb]:transition-[width,height,box-shadow]",
              "hover:**:data-[slot=slider-track]:h-1.5! active:**:data-[slot=slider-track]:h-1.5!",
              "hover:**:data-[slot=slider-thumb]:size-4 active:**:data-[slot=slider-thumb]:size-4"
            )}
            disabled={duration === null}
            max={duration === null ? 1 : Math.max(1, Math.round(duration * SLIDER_STEPS_PER_SECOND))}
            min={0}
            onPointerDown={playback.beginScrub}
            onValueChange={([value]) => playback.scrubTo((value ?? 0) / SLIDER_STEPS_PER_SECOND)}
            step={1}
            value={[duration === null ? 0 : Math.round(playback.currentTime * SLIDER_STEPS_PER_SECOND)]}
          />
        </div>
        <div className="flex items-center gap-1">
          <ControlButton label="Skip to start" onClick={playback.skipToStart}>
            <SkipBackIcon />
          </ControlButton>
          <ControlButton label={playLabel} onClick={playback.togglePlay}>
            {playback.paused ? <PlayIcon /> : <PauseIcon />}
          </ControlButton>
          <ControlButton label="Skip to end" onClick={playback.skipToEnd}>
            <SkipForwardIcon />
          </ControlButton>
          <span className="ml-2 text-xs tabular-nums">
            {formatTime(playback.currentTime)}
            {duration === null ? null : ` / ${formatTime(duration)}`}
          </span>
        </div>
      </div>
    </div>
  );
}

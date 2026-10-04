"use client";

import { VideoPlaybackControls } from "@/components/video-playback-controls";
import { Button } from "@/components/ui/button";
import { guidanceBoxStyle, guidanceView, videoSessionView, type GuidanceState } from "@/lib/assistant-guidance.mjs";
import { createStageFullscreen, type StageFullscreenState } from "@/lib/stage-fullscreen.mjs";
import type { CameraViewState, VideoSourceKind } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import type { VideoRecord } from "@/lib/video-library/types";
import { MaximizeIcon, MinimizeIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";

type CameraWorkspaceProps = {
  videoRef: Ref<HTMLVideoElement | null>;
  previewStream: MediaStream | null;
  videoFileUrl: string | null;
  activeVideo: VideoRecord | null;
  videoSource: VideoSourceKind;
  cameraView: CameraViewState;
  cameraError: string | null;
  sessionLive: boolean;
  fatalError: string | null;
  guidance: GuidanceState | null;
  sessionNotice: string | null;
  onFullscreenLayoutLock: (locked: boolean) => void;
  stageClassName?: string;
  controlBar: ReactNode;
  onVideoFileError: () => void;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as RefObject<T>).current = value;
}

function overlayCopy(
  view: CameraViewState,
  cameraError: string | null,
  videoSource: VideoSourceKind
): {
  title: string;
  body: string;
} | null {
  switch (view) {
    case "empty":
      return {
        title: "No video source",
        body: "Turn on the camera or choose a video from the library to preview the feed.",
      };
    case "permission":
      return {
        title: cameraError ? "Camera permission needed" : "Allow camera access",
        body: cameraError ?? "Allow camera access when the browser prompts you.",
      };
    case "connecting":
      switch (videoSource) {
        case "file":
          return {
            title: "Loading video",
            body: "Preparing the stored video.",
          };
        case "camera":
        case "none":
          return {
            title: "Starting camera",
            body: "Connecting to the camera.",
          };
        default: {
          const exhaustive: never = videoSource;
          return exhaustive;
        }
      }
    case "live":
      return null;
    case "error":
      switch (videoSource) {
        case "file":
          return {
            title: "Video unavailable",
            body: cameraError ?? "The browser could not play this video file.",
          };
        case "camera":
        case "none":
          return {
            title: "Camera unavailable",
            body: cameraError ?? "The camera could not be started.",
          };
        default: {
          const exhaustive: never = videoSource;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

function isFileSourceActive(videoSource: VideoSourceKind): boolean {
  switch (videoSource) {
    case "file":
      return true;
    case "none":
    case "camera":
      return false;
    default: {
      const exhaustive: never = videoSource;
      return exhaustive;
    }
  }
}

function showCameraVideo(view: CameraViewState): boolean {
  switch (view) {
    case "connecting":
    case "live":
      return true;
    case "empty":
    case "permission":
    case "error":
      return false;
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

function cameraStatusDotClass(sessionLive: boolean): string {
  return sessionLive ? "bg-destructive" : "bg-primary";
}

function previewAttachKind(
  previewStream: MediaStream | null,
  videoFileUrl: string | null
): "camera" | "file" | "none" {
  if (previewStream) {
    return "camera";
  }
  if (videoFileUrl) {
    return "file";
  }
  return "none";
}

function attachPreview(
  video: HTMLVideoElement,
  previewStream: MediaStream | null,
  videoFileUrl: string | null
) {
  const kind = previewAttachKind(previewStream, videoFileUrl);
  switch (kind) {
    case "camera":
      if (video.getAttribute("src")) {
        video.removeAttribute("src");
      }
      if (previewStream && video.srcObject !== previewStream) {
        video.srcObject = previewStream;
        void video.play().catch(() => undefined);
      }
      return;
    case "file":
      if (video.srcObject) {
        video.srcObject = null;
      }
      if (videoFileUrl && video.src !== videoFileUrl) {
        video.src = videoFileUrl;
      }
      video.muted = true;
      void video.play().catch(() => undefined);
      return;
    case "none":
      if (video.srcObject) {
        video.srcObject = null;
      }
      if (video.getAttribute("src")) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      return;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function CameraWorkspace({
  videoRef,
  previewStream,
  videoFileUrl,
  activeVideo,
  videoSource,
  cameraView,
  cameraError,
  sessionLive,
  fatalError,
  guidance,
  sessionNotice,
  onFullscreenLayoutLock,
  stageClassName,
  controlBar,
  onVideoFileError,
}: CameraWorkspaceProps) {
  const overlay = overlayCopy(cameraView, cameraError, videoSource);
  const showVideo = showCameraVideo(cameraView);
  const fileActive = isFileSourceActive(videoSource);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const fullscreenControllerRef = useRef<ReturnType<typeof createStageFullscreen> | null>(null);
  const [fullscreen, setFullscreen] = useState<StageFullscreenState>({ mode: "inline", notice: null });
  const sessionStatus = videoSessionView(sessionLive, fatalError);
  const guidanceDisplay = sessionStatus.error ? null : guidanceView(guidance, sessionLive, cameraView);
  const enlarged = fullscreen.mode !== "inline";
  const fullscreenLabel = fullscreen.mode === "expanded" ? "Close expanded video view" : enlarged ? "Exit video fullscreen" : "Enter video fullscreen";

  useEffect(() => {
    const element = stageElement;
    if (!element) return;
    const controller = createStageFullscreen({
      element,
      document,
      onLayoutLock: onFullscreenLayoutLock,
      onChange: (state) => {
        setFullscreen(state);
        if (state.mode === "inline") fullscreenButtonRef.current?.focus();
      },
    });
    fullscreenControllerRef.current = controller;
    return () => {
      controller.dispose();
      fullscreenControllerRef.current = null;
    };
  }, [onFullscreenLayoutLock, stageElement]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) {
      return;
    }
    attachPreview(video, previewStream, videoFileUrl);
  }, [previewStream, videoFileUrl]);

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col bg-camera-stage">
      <div className={cn("[container-type:size] flex min-h-0 flex-1", stageClassName ?? "p-6")}>
        <div
          aria-label={fullscreen.mode === "expanded" ? "Expanded video view" : "Video preview"}
          aria-modal={fullscreen.mode === "expanded" ? true : undefined}
          className={cn(
            "group/stage relative m-auto aspect-video w-[min(100%,calc(100cqh*16/9))] overflow-hidden rounded-lg bg-camera-preview",
            "[&:fullscreen]:m-0 [&:fullscreen]:h-screen [&:fullscreen]:w-screen [&:fullscreen]:rounded-none [&:fullscreen]:bg-black",
            fullscreen.mode === "expanded" && "fixed! inset-0 z-50 m-0! h-svh w-screen! rounded-none bg-black"
          )}
          onKeyDown={(event) => {
            if (!enlarged || event.key !== "Tab") return;
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [role="slider"]:not([data-disabled]), [tabindex="0"]:not([disabled])'));
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
          ref={setStageElement}
          role={fullscreen.mode === "expanded" ? "dialog" : undefined}
        >
          <video
            autoPlay
            className={cn("absolute inset-0 size-full object-contain", !showVideo && "opacity-0")}
            muted
            onError={() => {
              const video = localVideoRef.current;
              if (!video || !videoFileUrl) {
                return;
              }
              if (video.src !== videoFileUrl && video.currentSrc !== videoFileUrl) {
                return;
              }
              onVideoFileError();
            }}
            playsInline
            ref={(node) => {
              localVideoRef.current = node;
              assignRef(videoRef, node);
            }}
          />
          <Button
            aria-label={fullscreenLabel}
            aria-pressed={enlarged}
            className="absolute top-3 right-3 z-40 size-8 bg-black/75 text-white hover:bg-black/90 hover:text-white focus-visible:ring-white"
            onClick={() => {
              const controller = fullscreenControllerRef.current;
              if (enlarged) void controller?.exit();
              else void controller?.enter();
            }}
            ref={fullscreenButtonRef}
            size="icon"
            title={fullscreenLabel}
            type="button"
            variant="ghost"
          >
            {enlarged ? <MinimizeIcon aria-hidden /> : <MaximizeIcon aria-hidden />}
          </Button>
          {fullscreen.notice && !sessionStatus.error ? (
            <p className="pointer-events-none absolute top-14 inset-x-3 z-30 mx-auto max-w-xl rounded bg-black/85 px-3 py-2 text-center text-xs text-white" role="status">
              {fullscreen.notice}
            </p>
          ) : null}
          {guidanceDisplay ? (
            <div
              className="pointer-events-none absolute z-30 rounded-lg border border-white/20 bg-black/90 px-2 py-1.5 text-white shadow-lg"
              data-slot="assistant-guidance"
              style={guidanceBoxStyle(fileActive)}
            >
              <p className="mb-0.5 text-[8px] font-medium tracking-wide text-white/70 uppercase">{guidanceDisplay.label}</p>
              <p className="line-clamp-2 text-[12px] leading-[1.3] font-medium wrap-anywhere">{guidanceDisplay.text}</p>
              <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {guidanceDisplay.streaming ? "" : `${guidanceDisplay.label}: ${guidanceDisplay.text}`}
              </p>
            </div>
          ) : null}
          {sessionStatus.error ? (
            <div
              className="absolute top-3 left-3 z-30 max-h-[45%] w-max max-w-[min(20rem,calc(100%-4.5rem))] overflow-y-auto rounded-lg border border-red-300/30 bg-black/90 px-2.5 py-2 text-white shadow-lg focus-visible:outline focus-visible:outline-white"
              data-slot="video-session-error"
              role="alert"
              tabIndex={0}
            >
              <p className="text-xs font-medium text-red-200">{sessionStatus.label}</p>
              <p className="mt-1 text-[11px] leading-4 wrap-anywhere">{sessionStatus.error}</p>
              {fullscreen.notice ? <p className="mt-2 text-[11px] leading-4 text-white/70" role="status">{fullscreen.notice}</p> : null}
            </div>
          ) : cameraView === "live" ? (
            <div
              className={cn(
                "pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-4.5rem)] items-center gap-2 rounded-full bg-background/80 px-2.5 py-1 text-xs opacity-0 transition-opacity duration-200 group-has-focus-visible/stage:opacity-100",
                fileActive
                  ? "group-has-[[data-slot=playback-overlay][data-visible=true]]/stage:opacity-100"
                  : "group-hover/stage:opacity-100"
              )}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", cameraStatusDotClass(sessionLive))} />
              <span className="shrink-0">{sessionStatus.label}</span>
              {fileActive && activeVideo ? (
                <span className="truncate text-muted-foreground">{activeVideo.name}</span>
              ) : null}
            </div>
          ) : null}
          {overlay ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/80 px-6 py-4">
              <div className="flex max-w-md flex-col gap-2 text-center">
                <p className="text-lg font-medium">{overlay.title}</p>
                <p className="text-base leading-6 text-muted-foreground">{overlay.body}</p>
              </div>
            </div>
          ) : null}
          {fileActive && cameraView === "live" ? (
            <VideoPlaybackControls key={videoFileUrl} videoRef={localVideoRef} />
          ) : null}
        </div>
      </div>
      {sessionNotice ? <p className="px-3 pb-2 text-center text-xs text-muted-foreground" role="status">{sessionNotice}</p> : null}
      {controlBar}
    </main>
  );
}

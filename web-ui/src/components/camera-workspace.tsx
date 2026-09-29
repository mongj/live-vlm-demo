"use client";

import { VideoPlaybackControls } from "@/components/video-playback-controls";
import type { CameraViewState, VideoSourceKind } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import type { VideoRecord } from "@/lib/video-library/types";
import { useEffect, useRef, type ReactNode, type Ref, type RefObject } from "react";

type CameraWorkspaceProps = {
  videoRef: Ref<HTMLVideoElement | null>;
  previewStream: MediaStream | null;
  videoFileUrl: string | null;
  activeVideo: VideoRecord | null;
  videoSource: VideoSourceKind;
  cameraView: CameraViewState;
  cameraError: string | null;
  sessionLive: boolean;
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

function cameraStatusLabel(sessionLive: boolean): string {
  return sessionLive ? "Live" : "Ready";
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
  stageClassName,
  controlBar,
  onVideoFileError,
}: CameraWorkspaceProps) {
  const overlay = overlayCopy(cameraView, cameraError, videoSource);
  const showVideo = showCameraVideo(cameraView);
  const fileActive = isFileSourceActive(videoSource);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) {
      return;
    }
    attachPreview(video, previewStream, videoFileUrl);
  }, [previewStream, videoFileUrl]);

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col bg-camera-stage">
      <div className={cn("@container flex min-h-0 flex-1", stageClassName ?? "p-6")}>
        <div className="group/stage relative m-auto aspect-video w-[min(100%,calc(100cqh*16/9))] overflow-hidden rounded-lg bg-camera-preview">
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
          {cameraView === "live" ? (
            <div
              className={cn(
                "pointer-events-none absolute top-3 left-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-full bg-background/80 px-2.5 py-1 text-xs opacity-0 transition-opacity duration-200 group-has-focus-visible/stage:opacity-100",
                fileActive
                  ? "group-has-[[data-slot=playback-overlay][data-visible=true]]/stage:opacity-100"
                  : "group-hover/stage:opacity-100"
              )}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", cameraStatusDotClass(sessionLive))} />
              <span className="shrink-0">{cameraStatusLabel(sessionLive)}</span>
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
      {controlBar}
    </main>
  );
}

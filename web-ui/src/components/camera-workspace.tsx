"use client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CameraViewState, VideoSourceKind } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import { MicIcon, MicOffIcon, UploadIcon, VideoIcon, VideoOffIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ChangeEvent, type Ref, type RefObject } from "react";

type CameraWorkspaceProps = {
  videoRef: Ref<HTMLVideoElement | null>;
  previewStream: MediaStream | null;
  videoFileUrl: string | null;
  videoFileName: string | null;
  videoSource: VideoSourceKind;
  cameraView: CameraViewState;
  cameraError: string | null;
  cameraOn: boolean;
  micOn: boolean;
  micError: string | null;
  sessionLive: boolean;
  stageClassName?: string;
  onToggleCamera: () => void;
  onToggleMicrophone: () => void;
  onSelectVideoFile: (file: File) => void;
  onClearVideoFile: () => void;
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
        body: "Turn on the camera or upload a clip to preview the feed.",
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
            body: "Preparing the uploaded clip.",
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

function isCameraEngaged(view: CameraViewState, cameraError: string | null): boolean {
  switch (view) {
    case "connecting":
    case "live":
      return true;
    case "permission":
      return cameraError === null;
    case "empty":
    case "error":
      return false;
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

function isCameraButtonEngaged(
  view: CameraViewState,
  cameraError: string | null,
  videoSource: VideoSourceKind
): boolean {
  switch (videoSource) {
    case "file":
      return false;
    case "none":
    case "camera":
      return isCameraEngaged(view, cameraError);
    default: {
      const exhaustive: never = videoSource;
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
      video.loop = true;
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

function fileControlLabel(fileActive: boolean, videoFileName: string | null): string {
  if (!fileActive) {
    return "Upload video";
  }
  return videoFileName ? `Clear video (${videoFileName})` : "Clear video";
}

export function CameraWorkspace({
  videoRef,
  previewStream,
  videoFileUrl,
  videoFileName,
  videoSource,
  cameraView,
  cameraError,
  cameraOn,
  micOn,
  micError,
  sessionLive,
  stageClassName,
  onToggleCamera,
  onToggleMicrophone,
  onSelectVideoFile,
  onClearVideoFile,
  onVideoFileError,
}: CameraWorkspaceProps) {
  const overlay = overlayCopy(cameraView, cameraError, videoSource);
  const showVideo = showCameraVideo(cameraView);
  const cameraEngaged = isCameraButtonEngaged(cameraView, cameraError, videoSource);
  const cameraPending = cameraEngaged && !cameraOn;
  const cameraLabel = cameraEngaged ? "Turn camera off" : "Turn camera on";
  const micLabel = micOn ? "Turn microphone off" : "Turn microphone on";
  const fileActive = isFileSourceActive(videoSource);
  const filePending = fileActive && cameraView === "connecting";
  const fileLabel = fileControlLabel(fileActive, videoFileName);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) {
      return;
    }
    attachPreview(video, previewStream, videoFileUrl);
  }, [previewStream, videoFileUrl]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      onSelectVideoFile(file);
    }
  }

  function handleFileControlClick() {
    if (fileActive) {
      onClearVideoFile();
      return;
    }
    fileInputRef.current?.click();
  }

  function handleVideoEnded(event: { currentTarget: HTMLVideoElement }) {
    const video = event.currentTarget;
    video.currentTime = 0;
    void video.play().catch(() => undefined);
  }

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col bg-camera-stage">
      <div className={cn("@container flex min-h-0 flex-1", stageClassName ?? "p-6")}>
        <div className="relative m-auto aspect-video w-[min(100%,calc(100cqh*16/9))] overflow-hidden rounded-lg bg-camera-preview">
          <video
            autoPlay
            className={cn("absolute inset-0 size-full object-contain", !showVideo && "opacity-0")}
            loop
            muted
            onEnded={handleVideoEnded}
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
            <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-full bg-background/80 px-2.5 py-1 text-xs">
              <span className={cn("size-1.5 rounded-full", cameraStatusDotClass(sessionLive))} />
              {cameraStatusLabel(sessionLive)}
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
          <div className="absolute inset-x-0 bottom-4 z-20 flex flex-col items-center gap-2">
            {micError ? <p className="px-4 text-center text-xs text-destructive">{micError}</p> : null}
            <div className="flex items-center gap-3">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={cameraLabel}
                    aria-pressed={cameraEngaged}
                    className="size-12 rounded-full [&_svg:not([class*='size-'])]:size-5"
                    onClick={onToggleCamera}
                    size="icon"
                    type="button"
                    variant={cameraEngaged ? "secondary" : "destructive"}
                  >
                    {cameraPending ? (
                      <Spinner className="size-5" />
                    ) : cameraEngaged ? (
                      <VideoIcon />
                    ) : (
                      <VideoOffIcon />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{cameraLabel}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={micLabel}
                    aria-pressed={micOn}
                    className="size-12 rounded-full [&_svg:not([class*='size-'])]:size-5"
                    onClick={onToggleMicrophone}
                    size="icon"
                    type="button"
                    variant={micOn ? "secondary" : "destructive"}
                  >
                    {micOn ? <MicIcon /> : <MicOffIcon />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{micLabel}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label={fileLabel}
                    aria-pressed={fileActive}
                    className="size-12 rounded-full [&_svg:not([class*='size-'])]:size-5"
                    onClick={handleFileControlClick}
                    size="icon"
                    type="button"
                    variant={fileActive ? "secondary" : "outline"}
                  >
                    {filePending ? (
                      <Spinner className="size-5" />
                    ) : fileActive ? (
                      <XIcon />
                    ) : (
                      <UploadIcon />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{fileLabel}</TooltipContent>
              </Tooltip>
            </div>
            <input
              accept="video/*"
              aria-hidden
              className="hidden"
              onChange={handleFileChange}
              ref={fileInputRef}
              tabIndex={-1}
              type="file"
            />
          </div>
        </div>
      </div>
    </main>
  );
}

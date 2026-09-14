"use client";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CameraViewState } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import { MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from "lucide-react";
import type { RefObject } from "react";

type CameraWorkspaceProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  cameraView: CameraViewState;
  cameraError: string | null;
  cameraOn: boolean;
  micOn: boolean;
  micError: string | null;
  sessionLive: boolean;
  onToggleCamera: () => void;
  onToggleMicrophone: () => void;
};

function overlayCopy(
  view: CameraViewState,
  cameraError: string | null
): {
  title: string;
  body: string;
} | null {
  switch (view) {
    case "empty":
      return {
        title: "Camera is off",
        body: "Turn on the camera to preview the feed.",
      };
    case "permission":
      return {
        title: cameraError ? "Camera permission needed" : "Allow camera access",
        body: cameraError ?? "Allow camera access when the browser prompts you.",
      };
    case "connecting":
      return {
        title: "Starting camera",
        body: "Connecting to the camera.",
      };
    case "live":
      return null;
    case "error":
      return {
        title: "Camera unavailable",
        body: cameraError ?? "The camera could not be started.",
      };
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

export function CameraWorkspace({
  videoRef,
  cameraView,
  cameraError,
  cameraOn,
  micOn,
  micError,
  sessionLive,
  onToggleCamera,
  onToggleMicrophone,
}: CameraWorkspaceProps) {
  const overlay = overlayCopy(cameraView, cameraError);
  const showVideo = showCameraVideo(cameraView);
  const cameraEngaged = isCameraEngaged(cameraView, cameraError);
  const cameraPending = cameraEngaged && !cameraOn;
  const cameraLabel = cameraEngaged ? "Turn camera off" : "Turn camera on";
  const micLabel = micOn ? "Turn microphone off" : "Turn microphone on";

  return (
    <main className="flex h-full min-h-0 min-w-0 flex-col bg-camera-stage">
      <div className="@container flex min-h-0 flex-1 p-6">
        <div className="relative m-auto aspect-video w-[min(100%,calc(100cqh*16/9))] overflow-hidden rounded-lg bg-camera-preview">
          <video
            autoPlay
            className={cn("absolute inset-0 size-full object-contain", !showVideo && "opacity-0")}
            muted
            playsInline
            ref={videoRef}
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
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
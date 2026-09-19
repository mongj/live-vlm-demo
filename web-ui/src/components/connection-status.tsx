"use client";

import type { SessionPhase } from "@/hooks/use-playground";

type ConnectionStatusProps = {
  catalogStatus: "loading" | "ready" | "error";
  catalogError: string | null;
  phase: SessionPhase;
  sessionId: string | null;
  recoverableError: string | null;
  fatalError: string | null;
  cameraError: string | null;
};

function statusDotClass(tone: "idle" | "busy" | "live" | "error"): string {
  switch (tone) {
    case "idle":
      return "bg-muted-foreground";
    case "busy":
      return "bg-ring";
    case "live":
      return "bg-primary";
    case "error":
      return "bg-destructive";
    default: {
      const exhaustive: never = tone;
      return exhaustive;
    }
  }
}

function describeStatus(props: ConnectionStatusProps): {
  label: string;
  detail: string | null;
  tone: "idle" | "busy" | "live" | "error";
} {
  if (props.catalogStatus === "loading") {
    return { label: "Loading Catalog", detail: null, tone: "busy" };
  }
  if (props.catalogStatus === "error") {
    return {
      label: "Catalog unavailable",
      detail: props.catalogError,
      tone: "error",
    };
  }
  if (props.cameraError) {
    return { label: "Camera", detail: props.cameraError, tone: "error" };
  }
  if (props.fatalError) {
    return { label: "Session ended", detail: props.fatalError, tone: "error" };
  }
  switch (props.phase) {
    case "connecting":
      return { label: "Connecting", detail: null, tone: "busy" };
    case "live":
      return {
        label: "Live",
        detail: props.sessionId,
        tone: "live",
      };
    case "idle":
      return {
        label: "Ready",
        detail: props.recoverableError,
        tone: props.recoverableError ? "error" : "idle",
      };
    default: {
      const exhaustive: never = props.phase;
      return exhaustive;
    }
  }
}

export function ConnectionStatus(props: ConnectionStatusProps) {
  const status = describeStatus(props);
  const liveError = props.phase === "live" ? props.recoverableError : null;
  const detail = liveError ?? status.detail;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <span className={`size-1.5 shrink-0 rounded-full ${statusDotClass(status.tone)}`} />
        <span>{status.label}</span>
      </div>
      {detail ? (
        <p className="pl-3.5 text-xs leading-5 text-muted-foreground wrap-break-word">{detail}</p>
      ) : null}
    </div>
  );
}

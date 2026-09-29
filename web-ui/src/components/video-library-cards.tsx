"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { VideoThumbnail } from "@/components/video-thumbnail";
import { useRemoteThumbnail } from "@/hooks/use-remote-thumbnail";
import type { PendingDownload, PendingUpload } from "@/hooks/use-video-library";
import { cn } from "@/lib/utils";
import type { RemoteVideo } from "@/lib/video-library/remote-sources";
import type { VideoRecord } from "@/lib/video-library/types";
import {
  DownloadIcon,
  EllipsisVerticalIcon,
  FileVideoIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import Image from "next/image";
/** Shared by thumbnails, the upload cell and upload placeholders so every box in the grid lines up. */
const THUMBNAIL_BOX_CLASS = "aspect-video w-full rounded-lg";
const CARD_TITLE_CLASS = "line-clamp-2 text-sm leading-snug font-medium wrap-break-word";
const CARD_META_CLASS = "text-xs text-muted-foreground";
/** Stretches the title button over the whole card so the thumbnail is clickable too. */
const CARD_HIT_AREA_CLASS =
  "block min-w-0 flex-1 cursor-pointer pt-1 text-left outline-none after:absolute after:-inset-1.5 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

type UploadCardVariant = "cell" | "panel";

type UploadCardStyles = { box: string; dragging: string; iconFrame: string; icon: string };

const UPLOAD_CARD_VARIANTS: Record<UploadCardVariant, UploadCardStyles> = {
  cell: {
    box: cn(
      THUMBNAIL_BOX_CLASS,
      "border border-dashed border-foreground/20 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    ),
    dragging: "border-primary bg-muted text-foreground",
    iconFrame: "",
    icon: "size-6",
  },
  /** Fills its parent edge to edge, bounded by the surrounding dividers; used when the library has no videos yet. */
  panel: {
    box: "min-h-64 w-full flex-1 hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
    dragging: "bg-muted text-foreground ring-2 ring-primary ring-inset",
    iconFrame: "mb-1",
    icon: "size-8",
  },
};

export function UploadCard({
  dragging,
  uploading,
  onClick,
  variant = "cell",
}: {
  dragging: boolean;
  uploading: boolean;
  onClick: () => void;
  variant?: UploadCardVariant;
}) {
  const styles = UPLOAD_CARD_VARIANTS[variant];
  return (
    <button
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground transition-colors outline-none disabled:cursor-default disabled:opacity-60",
        styles.box,
        dragging && styles.dragging
      )}
      disabled={uploading}
      onClick={onClick}
      type="button"
    >
      <span className={cn("flex", styles.iconFrame)}>
        {uploading ? <Spinner className={styles.icon} /> : <UploadIcon className={styles.icon} />}
      </span>
      <span className="text-sm font-medium text-foreground">
        {uploading ? "Saving…" : "Drop videos here or click to upload"}
      </span>
    </button>
  );
}

export function PendingUploadCard({ pending, onCancel }: { pending: PendingUpload; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          THUMBNAIL_BOX_CLASS,
          "flex flex-col items-center justify-center gap-3 bg-muted px-6 text-muted-foreground"
        )}
      >
        <Spinner className="size-6" />
        <Progress aria-label={`Saving ${pending.name}`} className="w-full bg-foreground/10" value={pending.percent} />
      </div>
      <div className="flex items-start gap-1 px-0.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className={CARD_TITLE_CLASS} title={pending.name}>
            {pending.name}
          </p>
          <p className={cn(CARD_META_CLASS, "tabular-nums")}>Saving… {pending.percent}%</p>
        </div>
        <Button
          aria-label={`Cancel upload of ${pending.name}`}
          className="-mr-1.5 shrink-0"
          onClick={onCancel}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}

type VideoCardProps = {
  video: VideoRecord;
  active: boolean;
  onSelect: () => void;
  onStop: () => void;
  /** Omitted when the video's provider is read-only. */
  onRemove?: () => void;
};

export function VideoCard({ video, active, onSelect, onStop, onRemove }: VideoCardProps) {
  const hasActions = active || Boolean(onRemove);
  return (
    <div className="group/video relative flex flex-col gap-2">
      <VideoThumbnail
        className={cn(
          THUMBNAIL_BOX_CLASS,
          "transition-opacity group-hover/video:opacity-90 [&>svg]:size-8",
          active && "ring-2 ring-primary ring-offset-2 ring-offset-background"
        )}
        video={video}
      >
        {active ? <Badge className="absolute top-2 left-2">In use</Badge> : null}
        {video.durationMs !== null ? (
          <Badge className="absolute right-1.5 bottom-1.5 rounded-sm bg-black/80 px-1 text-white tabular-nums">
            {formatDuration(video.durationMs)}
          </Badge>
        ) : null}
      </VideoThumbnail>
      <div className="flex items-start gap-1 px-0.5">
        <button
          aria-current={active ? "true" : undefined}
          className={CARD_HIT_AREA_CLASS}
          onClick={onSelect}
          title={video.name}
          type="button"
        >
          <span className={CARD_TITLE_CLASS}>{video.name}</span>
        </button>
        {hasActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`More actions for ${video.name}`}
                className="relative z-10 -mr-1.5 shrink-0"
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <EllipsisVerticalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {active ? (
                <DropdownMenuItem onSelect={onStop}>
                  <SquareIcon />
                  Stop using
                </DropdownMenuItem>
              ) : null}
              {onRemove ? (
                <DropdownMenuItem onSelect={onRemove} variant="destructive">
                  <Trash2Icon />
                  Remove
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

function downloadPhaseLabel(phase: PendingDownload["phase"]): string {
  switch (phase) {
    case "downloading":
      return "Downloading…";
    case "saving":
      return "Saving…";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

/** The gateway-generated frame, loaded once near the viewport; falls back to an icon when the video can't be decoded. */
function RemoteThumbnail({ video, root }: { video: RemoteVideo; root: Element | null }) {
  const { observe, result } = useRemoteThumbnail(video.thumbnailUrl, root);
  const loaded = result?.status === "loaded" ? result : null;
  const failed = result?.status === "failed";
  const durationMs = video.durationMs ?? loaded?.durationMs ?? null;
  return (
    <div
      className={cn(
        THUMBNAIL_BOX_CLASS,
        "relative flex items-center justify-center overflow-hidden bg-muted text-muted-foreground transition-colors group-hover/video:text-foreground [&>svg]:size-8"
      )}
      ref={observe}
    >
      {failed ? (
        <>
          <FileVideoIcon className="group-hover/video:hidden" />
          <DownloadIcon className="hidden group-hover/video:block" />
        </>
      ) : (
        <>
          {loaded ? (
            <Image
              alt=""
              className="object-cover transition-opacity group-hover/video:opacity-70"
              fill
              loading="eager"
              sizes="320px"
              src={loaded.objectUrl}
              unoptimized
            />
          ) : null}
          <span className="relative hidden rounded-full bg-black/70 p-2.5 text-white group-hover/video:flex">
            <DownloadIcon className="size-5" />
          </span>
        </>
      )}
      {durationMs !== null ? (
        <Badge className="absolute right-1.5 bottom-1.5 rounded-sm bg-black/80 px-1 text-white tabular-nums">
          {formatDuration(durationMs)}
        </Badge>
      ) : null}
    </div>
  );
}

type RemoteVideoCardProps = {
  video: RemoteVideo;
  /** The downloaded copy, once the video is in the library. */
  stored: VideoRecord | undefined;
  pending: PendingDownload | undefined;
  active: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onUse: (video: VideoRecord) => void;
  onStop: () => void;
  onRemove: (video: VideoRecord) => void;
  /** The scroll container thumbnails load relative to. */
  thumbnailRoot: Element | null;
};

export function RemoteVideoCard({
  video,
  stored,
  pending,
  active,
  onDownload,
  onCancel,
  onUse,
  onStop,
  onRemove,
  thumbnailRoot,
}: RemoteVideoCardProps) {
  if (pending) {
    const label = downloadPhaseLabel(pending.phase);
    return (
      <div className="flex flex-col gap-2">
        <div
          className={cn(
            THUMBNAIL_BOX_CLASS,
            "flex flex-col items-center justify-center gap-3 bg-muted px-6 text-muted-foreground"
          )}
        >
          <Spinner className="size-6" />
          <Progress aria-label={`${label} ${video.name}`} className="w-full bg-foreground/10" value={pending.percent} />
        </div>
        <div className="flex items-start gap-1 px-0.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className={CARD_TITLE_CLASS} title={video.name}>
              {video.name}
            </p>
            <p className={cn(CARD_META_CLASS, "tabular-nums")}>
              {label} {pending.percent}%
            </p>
          </div>
          <Button
            aria-label={`Cancel download of ${video.name}`}
            className="-mr-1.5 shrink-0"
            onClick={onCancel}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/video relative flex flex-col gap-2">
      {stored ? (
        <VideoThumbnail
          className={cn(
            THUMBNAIL_BOX_CLASS,
            "transition-opacity group-hover/video:opacity-90 [&>svg]:size-8",
            active && "ring-2 ring-primary ring-offset-2 ring-offset-background"
          )}
          video={stored}
        >
          <Badge className="absolute top-2 left-2" variant={active ? "default" : "secondary"}>
            {active ? "In use" : "In library"}
          </Badge>
          {stored.durationMs !== null ? (
            <Badge className="absolute right-1.5 bottom-1.5 rounded-sm bg-black/80 px-1 text-white tabular-nums">
              {formatDuration(stored.durationMs)}
            </Badge>
          ) : null}
        </VideoThumbnail>
      ) : (
        <RemoteThumbnail root={thumbnailRoot} video={video} />
      )}
      <div className="flex items-start gap-1 px-0.5">
        <button
          aria-current={active ? "true" : undefined}
          aria-label={stored ? `Use ${video.name}` : `Download ${video.name}`}
          className={CARD_HIT_AREA_CLASS}
          onClick={stored ? () => onUse(stored) : onDownload}
          title={video.name}
          type="button"
        >
          <span className={CARD_TITLE_CLASS}>{video.name}</span>
          <span className={cn(CARD_META_CLASS, "mt-0.5 block tabular-nums")}>{formatBytes(video.sizeBytes)}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`More actions for ${video.name}`}
              className="relative z-10 -mr-1.5 shrink-0"
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!stored ? (
              <DropdownMenuItem onSelect={onDownload}>
                <DownloadIcon />
                Download
              </DropdownMenuItem>
            ) : active ? (
              <DropdownMenuItem onSelect={onStop}>
                <SquareIcon />
                Stop using
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => onUse(stored)}>
                <PlayIcon />
                Use video
              </DropdownMenuItem>
            )}
            {stored ? (
              <DropdownMenuItem onSelect={() => onRemove(stored)} variant="destructive">
                <Trash2Icon />
                Remove from library
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

"use client";

import { useVideoThumbnail } from "@/hooks/use-video-thumbnail";
import { cn } from "@/lib/utils";
import type { VideoRef } from "@/lib/video-library/types";
import { FileVideoIcon } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";

export function VideoThumbnail({
  video,
  className,
  children,
}: {
  video: VideoRef;
  className?: string;
  /** Overlays such as badges, positioned against the thumbnail. */
  children?: ReactNode;
}) {
  const url = useVideoThumbnail(video);
  return (
    <div
      className={cn(
        "relative flex aspect-video shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted text-muted-foreground",
        className
      )}
    >
      {url ? <Image alt="" className="object-cover" fill sizes="320px" src={url} unoptimized /> : <FileVideoIcon />}
      {children}
    </div>
  );
}

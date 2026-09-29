"use client";

import { getVideoLibrary } from "@/lib/video-library/library";
import { videoKey, type VideoRef } from "@/lib/video-library/types";
import { useEffect, useState } from "react";

/** A thumbnail URL for `video`, or `null` while loading or when none can be made. Released on unmount. */
export function useVideoThumbnail(video: VideoRef): string | null {
  const { id, providerId } = video;
  const key = videoKey(video);
  const [thumbnail, setThumbnail] = useState<{ key: string; url: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | undefined;
    const ref = { id, providerId };
    getVideoLibrary()
      .openThumbnail(ref)
      .then((result) => {
        if (!result) {
          return;
        }
        if (cancelled) {
          result.release();
          return;
        }
        release = result.release;
        setThumbnail({ key: videoKey(ref), url: result.url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      release?.();
    };
  }, [id, providerId]);

  return thumbnail?.key === key ? thumbnail.url : null;
}

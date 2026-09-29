"use client";

import { getThumbnailLoader, type ThumbnailResult } from "@/lib/video-library/thumbnail-loader";
import { useEffect, useState, useSyncExternalStore } from "react";

/** Loads a gateway thumbnail once the element passed to `observe` comes near the viewport of `root`. */
export function useRemoteThumbnail(
  url: string,
  root: Element | null
): { observe: (element: HTMLElement | null) => void; result: ThumbnailResult | undefined } {
  const loader = getThumbnailLoader();
  const [element, setElement] = useState<HTMLElement | null>(null);
  const result = useSyncExternalStore(
    (listener) => loader.subscribe(url, listener),
    () => loader.getResult(url),
    () => undefined
  );

  useEffect(() => {
    if (!element || !root) {
      return;
    }
    return loader.watch(element, root, url);
  }, [element, loader, root, url]);

  return { observe: setElement, result };
}

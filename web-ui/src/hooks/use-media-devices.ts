"use client";

import { EMPTY_DEVICE_LISTS, listMediaDevices, type MediaDeviceLists } from "@/lib/media-devices";
import { useEffect, useState } from "react";

export type MediaDevicesState = MediaDeviceLists & {
  /** Re-reads devices, e.g. after a permission grant exposes labels. */
  refresh: () => void;
};

export function useMediaDevices(): MediaDevicesState {
  const [lists, setLists] = useState<MediaDeviceLists>(EMPTY_DEVICE_LISTS);

  function refresh() {
    void listMediaDevices()
      .then(setLists)
      .catch(() => undefined);
  }

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listMediaDevices()
        .then((next) => {
          if (!cancelled) {
            setLists(next);
          }
        })
        .catch(() => undefined);
    };
    load();
    const mediaDevices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    mediaDevices?.addEventListener("devicechange", load);
    return () => {
      cancelled = true;
      mediaDevices?.removeEventListener("devicechange", load);
    };
  }, []);

  return { ...lists, refresh };
}

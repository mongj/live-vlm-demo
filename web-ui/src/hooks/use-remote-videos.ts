"use client";

import { listRemoteVideos, type RemoteVideo } from "@/lib/video-library/remote-sources";
import { useEffect, useState } from "react";

export type RemoteVideosState =
  | { status: "loading" }
  | { status: "ready"; videos: RemoteVideo[] }
  | { status: "error"; message: string };

type Settled = { requestKey: string; state: Exclude<RemoteVideosState, { status: "loading" }> };

/** Lists a remote source's catalog, refetching whenever `sourceId` changes or `reload` is called. */
export function useRemoteVideos(sourceId: string): RemoteVideosState & { reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled | null>(null);
  const requestKey = `${sourceId}#${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    listRemoteVideos(sourceId, controller.signal).then(
      (videos) => setSettled({ requestKey, state: { status: "ready", videos } }),
      (error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error && error.message ? error.message : "Unable to list videos";
        setSettled({ requestKey, state: { status: "error", message } });
      }
    );
    return () => controller.abort();
  }, [requestKey, sourceId]);

  const state: RemoteVideosState = settled?.requestKey === requestKey ? settled.state : { status: "loading" };
  return { ...state, reload: () => setAttempt((current) => current + 1) };
}

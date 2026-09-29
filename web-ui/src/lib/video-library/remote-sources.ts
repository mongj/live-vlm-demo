import { getVideosUrl, getVideoThumbnailUrl } from "@/lib/gateway";
import type { SaveOptions, VideoOrigin } from "@/lib/video-library/types";

/**
 * Remote catalogs the library can browse. Their videos are downloaded into local storage
 * rather than streamed, so they appear under "All videos" once imported.
 */
export type RemoteSource = {
  /** The gateway's video library `key`. */
  id: string;
  name: string;
};

export type RemoteVideo = {
  sourceId: string;
  name: string;
  sizeBytes: number;
  /** Known once the gateway has generated the video's thumbnail. */
  durationMs: number | null;
  thumbnailUrl: string;
};

export const REMOTE_SOURCES: readonly RemoteSource[] = [
  { id: "spot-bench", name: "SPOT-Bench" },
  { id: "ego-proactive", name: "EgoProactive" },
];

const DEFAULT_VIDEO_TYPE = "video/mp4";

export function findRemoteSource(id: string): RemoteSource | undefined {
  return REMOTE_SOURCES.find((source) => source.id === id);
}

export function remoteVideoKey(video: VideoOrigin): string {
  return `${video.sourceId}:${video.name}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRemoteVideo(value: unknown, sourceId: string): RemoteVideo | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    return null;
  }
  if (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) {
    return null;
  }
  const duration = value.duration_ms;
  return {
    sourceId,
    name: value.name,
    sizeBytes: value.size,
    durationMs: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
    thumbnailUrl: getVideoThumbnailUrl(sourceId, value.name),
  };
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : null;
  return new Error(detail ? `${fallback}: ${detail}` : `${fallback} (${response.status})`);
}

export async function listRemoteVideos(sourceId: string, signal?: AbortSignal): Promise<RemoteVideo[]> {
  const response = await fetch(getVideosUrl(sourceId), { cache: "no-store", signal });
  if (!response.ok) {
    throw await responseError(response, "Unable to list videos");
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.videos)) {
    throw new Error("Video list response was missing videos");
  }
  return body.videos
    .map((value) => parseRemoteVideo(value, sourceId))
    .filter((video): video is RemoteVideo => video !== null);
}

/** Buffers the whole file in memory; `onProgress` reports bytes received against the listed size. */
export async function downloadRemoteVideo(
  video: RemoteVideo,
  { onProgress, signal }: SaveOptions = {}
): Promise<Blob> {
  const response = await fetch(getVideosUrl(video.sourceId, video.name), { cache: "no-store", signal });
  if (!response.ok) {
    throw await responseError(response, `Unable to download ${video.name}`);
  }
  const type = response.headers.get("content-type") ?? DEFAULT_VIDEO_TYPE;
  const totalBytes = video.sizeBytes || Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    const blob = await response.blob();
    onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loadedBytes = 0;
  onProgress?.({ loadedBytes, totalBytes });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        break;
      }
      chunks.push(value);
      loadedBytes += value.byteLength;
      onProgress?.({ loadedBytes, totalBytes: Math.max(totalBytes, loadedBytes) });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return new Blob(chunks, { type });
}

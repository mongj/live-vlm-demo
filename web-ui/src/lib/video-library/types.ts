/** Where a stored video lives. Add remote backends (e.g. `"s3"`) here. */
export type VideoProviderId = "local";

/** The remote catalog entry a stored video was downloaded from. */
export type VideoOrigin = {
  sourceId: string;
  name: string;
};

export type VideoRecord = {
  /** Unique within its provider only; use `videoKey` for a library-wide identity. */
  id: string;
  providerId: VideoProviderId;
  name: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  /** Unix milliseconds. */
  createdAt: number;
  origin?: VideoOrigin;
};

export type VideoRef = Pick<VideoRecord, "id" | "providerId">;

export type NewVideo = {
  blob: Blob;
  name: string;
  mimeType: string;
  durationMs: number | null;
  thumbnail: Blob | null;
  origin?: VideoOrigin;
};

export type TransferProgress = {
  loadedBytes: number;
  totalBytes: number;
};

export type SaveOptions = {
  onProgress?: (progress: TransferProgress) => void;
  /** Aborting must leave no partial video behind. */
  signal?: AbortSignal;
};

export type ReleasableUrl = {
  url: string;
  release: () => void;
};

/**
 * A playable URL for a stored video. The URL must be same-origin, a `blob:` URL, or served
 * with CORS headers, otherwise drawing Frames onto the capture canvas taints it.
 */
export type VideoPlayback = ReleasableUrl;

export interface VideoProvider {
  readonly id: VideoProviderId;
  readonly label: string;
  list(): Promise<VideoRecord[]>;
  open(id: string): Promise<VideoPlayback>;
  /** Resolves `null` when the video has no thumbnail yet. Remote providers can return a server-generated URL. */
  openThumbnail?(id: string): Promise<ReleasableUrl | null>;
  /** Stores a thumbnail generated in the browser; omitted by providers that generate their own. */
  saveThumbnail?(id: string, thumbnail: Blob): Promise<void>;
  /** Omitted by read-only providers. */
  save?(video: NewVideo, options?: SaveOptions): Promise<VideoRecord>;
  /** Omitted by read-only providers. */
  remove?(id: string): Promise<void>;
}

export function videoKey(video: VideoRef): string {
  return `${video.providerId}:${video.id}`;
}

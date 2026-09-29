"use client";

import { getVideoLibrary } from "@/lib/video-library/library";
import { downloadRemoteVideo, remoteVideoKey, type RemoteVideo } from "@/lib/video-library/remote-sources";
import { videoKey, type TransferProgress, type VideoProviderId, type VideoRecord } from "@/lib/video-library/types";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";

export type StorageUsage = {
  usedBytes: number;
  quotaBytes: number;
};

export type PendingUpload = {
  id: string;
  name: string;
  /** Whole-number percentage of bytes written. */
  percent: number;
};

export type PendingDownload = {
  /** `remoteVideoKey` of the remote video. */
  key: string;
  /** Bytes are fetched from the gateway, then written into browser storage. */
  phase: "downloading" | "saving";
  percent: number;
};

export type VideoLibraryState = {
  status: "loading" | "ready" | "error";
  videos: VideoRecord[];
  listError: string | null;
  uploadError: string | null;
  pendingUploads: PendingUpload[];
  storage: StorageUsage | null;
  canUpload: boolean;
  upload: (files: File[]) => Promise<VideoRecord[]>;
  cancelUpload: (id: string) => void;
  remove: (video: VideoRecord) => Promise<void>;
  canRemove: (video: VideoRecord) => boolean;
  providerLabel: (id: VideoProviderId) => string;
  downloads: PendingDownload[];
  downloadError: string | null;
  download: (video: RemoteVideo) => Promise<VideoRecord | null>;
  cancelDownload: (key: string) => void;
  /** The stored copy of a remote video, if it has been downloaded. */
  findDownloaded: (video: RemoteVideo) => VideoRecord | undefined;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function readStorageUsage(): Promise<StorageUsage | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return null;
  }
  try {
    const estimate = await navigator.storage.estimate();
    if (!estimate.quota) {
      return null;
    }
    return { usedBytes: estimate.usage ?? 0, quotaBytes: estimate.quota };
  } catch {
    return null;
  }
}

async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // Best effort: without persistence the browser may evict videos under storage pressure.
  }
}

type LibrarySnapshot = {
  status: "ready" | "error";
  videos: VideoRecord[];
  listError: string | null;
  canUpload: boolean;
  storage: StorageUsage | null;
};

async function readSnapshot(): Promise<LibrarySnapshot> {
  const library = getVideoLibrary();
  const canUpload = Boolean(library.uploadTarget);
  let snapshot: Omit<LibrarySnapshot, "canUpload" | "storage">;
  try {
    const result = await library.list();
    snapshot = {
      videos: result.videos,
      listError: result.failures.map((failure) => failure.message).join("; ") || null,
      status: result.failures.length > 0 && result.videos.length === 0 ? "error" : "ready",
    };
  } catch (error) {
    snapshot = { videos: [], listError: errorMessage(error, "Unable to load stored videos"), status: "error" };
  }
  return { ...snapshot, canUpload, storage: await readStorageUsage() };
}

export function useVideoLibrary(): VideoLibraryState {
  const [status, setStatus] = useState<VideoLibraryState["status"]>("loading");
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [storage, setStorage] = useState<StorageUsage | null>(null);
  const [canUpload, setCanUpload] = useState(false);
  const uploadControllersRef = useRef(new Map<string, AbortController>());
  const [downloads, setDownloads] = useState<PendingDownload[]>([]);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadControllersRef = useRef(new Map<string, AbortController>());

  function applySnapshot(snapshot: LibrarySnapshot) {
    setVideos(snapshot.videos);
    setListError(snapshot.listError);
    setStatus(snapshot.status);
    setCanUpload(snapshot.canUpload);
    setStorage(snapshot.storage);
  }

  useEffect(() => {
    let cancelled = false;
    void readSnapshot().then((snapshot) => {
      if (!cancelled) {
        applySnapshot(snapshot);
      }
    });
    const controllers = [uploadControllersRef.current, downloadControllersRef.current];
    return () => {
      cancelled = true;
      for (const controller of controllers.flatMap((map) => [...map.values()])) {
        controller.abort();
      }
    };
  }, []);

  async function upload(files: File[]): Promise<VideoRecord[]> {
    const library = getVideoLibrary();
    const saved: VideoRecord[] = [];
    const failures: string[] = [];
    setUploadError(null);
    void requestPersistentStorage();
    const queue = files.map((file) => ({ file, id: nanoid(), controller: new AbortController() }));
    for (const entry of queue) {
      uploadControllersRef.current.set(entry.id, entry.controller);
    }
    setPendingUploads((current) => [
      ...current,
      ...queue.map(({ file, id }) => ({ id, name: file.name, percent: 0 })),
    ]);
    for (const { file, id, controller } of queue) {
      let lastPercent = 0;
      try {
        if (controller.signal.aborted) {
          continue;
        }
        const record = await library.upload(file, {
          signal: controller.signal,
          onProgress: ({ loadedBytes, totalBytes }) => {
            const percent = totalBytes > 0 ? Math.floor((loadedBytes / totalBytes) * 100) : 100;
            if (percent === lastPercent) {
              return;
            }
            lastPercent = percent;
            setPendingUploads((current) =>
              current.map((pending) => (pending.id === id ? { ...pending, percent } : pending))
            );
          },
        });
        saved.push(record);
        setVideos((current) => [record, ...current.filter((video) => videoKey(video) !== videoKey(record))]);
      } catch (error) {
        if (!controller.signal.aborted) {
          failures.push(errorMessage(error, `Unable to store ${file.name}`));
        }
      } finally {
        uploadControllersRef.current.delete(id);
        setPendingUploads((current) => current.filter((pending) => pending.id !== id));
      }
    }
    setUploadError(failures.length > 0 ? failures.join("; ") : null);
    setStorage(await readStorageUsage());
    return saved;
  }

  async function download(remote: RemoteVideo): Promise<VideoRecord | null> {
    const key = remoteVideoKey(remote);
    if (downloadControllersRef.current.has(key)) {
      return null;
    }
    const controller = new AbortController();
    downloadControllersRef.current.set(key, controller);
    setDownloadError(null);
    void requestPersistentStorage();
    setDownloads((current) => [...current, { key, phase: "downloading", percent: 0 }]);
    let lastPercent = 0;
    const setProgress = (phase: PendingDownload["phase"], percent: number) => {
      lastPercent = percent;
      setDownloads((current) => current.map((entry) => (entry.key === key ? { key, phase, percent } : entry)));
    };
    const reportProgress =
      (phase: PendingDownload["phase"]) =>
      ({ loadedBytes, totalBytes }: TransferProgress) => {
        const percent = totalBytes > 0 ? Math.min(100, Math.floor((loadedBytes / totalBytes) * 100)) : 100;
        if (percent !== lastPercent) {
          setProgress(phase, percent);
        }
      };
    try {
      const blob = await downloadRemoteVideo(remote, {
        signal: controller.signal,
        onProgress: reportProgress("downloading"),
      });
      setProgress("saving", 0);
      const file = new File([blob], remote.name, { type: blob.type });
      const record = await getVideoLibrary().upload(file, {
        signal: controller.signal,
        onProgress: reportProgress("saving"),
        origin: { sourceId: remote.sourceId, name: remote.name },
      });
      setVideos((current) => [record, ...current.filter((video) => videoKey(video) !== videoKey(record))]);
      return record;
    } catch (error) {
      if (!controller.signal.aborted) {
        setDownloadError(errorMessage(error, `Unable to download ${remote.name}`));
      }
      return null;
    } finally {
      downloadControllersRef.current.delete(key);
      setDownloads((current) => current.filter((entry) => entry.key !== key));
      setStorage(await readStorageUsage());
    }
  }

  async function remove(video: VideoRecord) {
    const key = videoKey(video);
    await getVideoLibrary().remove(video);
    setVideos((current) => current.filter((entry) => videoKey(entry) !== key));
    setStorage(await readStorageUsage());
  }

  return {
    status,
    videos,
    listError,
    uploadError,
    pendingUploads,
    storage,
    canUpload,
    upload,
    cancelUpload: (id) => uploadControllersRef.current.get(id)?.abort(),
    remove,
    canRemove: (video) => getVideoLibrary().canRemove(video),
    providerLabel: (id) => getVideoLibrary().providerLabel(id),
    downloads,
    downloadError,
    download,
    cancelDownload: (key) => downloadControllersRef.current.get(key)?.abort(),
    findDownloaded: (remote) =>
      videos.find((video) => video.origin && remoteVideoKey(video.origin) === remoteVideoKey(remote)),
  };
}

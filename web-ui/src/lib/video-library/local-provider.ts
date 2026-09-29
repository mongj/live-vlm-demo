import type {
  NewVideo,
  ReleasableUrl,
  SaveOptions,
  TransferProgress,
  VideoPlayback,
  VideoProvider,
  VideoRecord,
} from "@/lib/video-library/types";
import { nanoid } from "nanoid";

const DB_NAME = "live-vlm-video-library";
const DB_VERSION = 2;
const METADATA_STORE = "videos";
const LEGACY_BLOB_STORE = "blobs";
const OPFS_DIRECTORY = "videos";
const WRITE_LOCK = "live-vlm-video-library-write";
const WRITE_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_THUMBNAIL_TYPE = "image/jpeg";

type StoredThumbnail = {
  /** File name inside the OPFS `videos` directory. */
  fileName: string;
  mimeType: string;
};

type StoredMetadata = Omit<VideoRecord, "providerId"> & {
  /** File name inside the OPFS `videos` directory. */
  fileName: string;
  thumbnail?: StoredThumbnail;
};

function storedThumbnail(id: string, blob: Blob): StoredThumbnail {
  return { fileName: `${id}.thumbnail`, mimeType: blob.type || DEFAULT_THUMBNAIL_TYPE };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser does not support IndexedDB"));
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = (event) => {
    const db = request.result;
    if (!db.objectStoreNames.contains(METADATA_STORE)) {
      db.createObjectStore(METADATA_STORE, { keyPath: "id" });
    } else if (event.oldVersion < 2) {
      // Version 1 records point at the dropped blob store, so they cannot be opened.
      request.transaction?.objectStore(METADATA_STORE).clear();
    }
    if (db.objectStoreNames.contains(LEGACY_BLOB_STORE)) {
      db.deleteObjectStore(LEGACY_BLOB_STORE);
    }
  };
  return requestResult(request).then((db) => {
    db.onversionchange = () => db.close();
    return db;
  });
}

async function openVideoDirectory(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    throw new Error("This browser does not support the Origin Private File System");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIRECTORY, { create: true });
}

/** Writers share the lock; cleanup takes it exclusively so it never deletes a file mid-upload in any tab. */
async function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  if (!navigator.locks) {
    return task();
  }
  return await navigator.locks.request(WRITE_LOCK, { mode: "shared" }, task);
}

async function removeFile(directory: FileSystemDirectoryHandle, fileName: string) {
  await directory.removeEntry(fileName).catch(() => undefined);
}

async function writeBlob(
  handle: FileSystemFileHandle,
  blob: Blob,
  onProgress: ((progress: TransferProgress) => void) | undefined,
  signal: AbortSignal | undefined
) {
  const writable = await handle.createWritable();
  onProgress?.({ loadedBytes: 0, totalBytes: blob.size });
  try {
    for (let offset = 0; offset < blob.size; offset += WRITE_CHUNK_BYTES) {
      signal?.throwIfAborted();
      const chunk = blob.slice(offset, offset + WRITE_CHUNK_BYTES);
      await writable.write(chunk);
      onProgress?.({ loadedBytes: offset + chunk.size, totalBytes: blob.size });
    }
    signal?.throwIfAborted();
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/** Stores video bytes in OPFS and their metadata in IndexedDB. */
export class LocalVideoProvider implements VideoProvider {
  readonly id = "local" as const;
  readonly label = "This browser";
  private database: Promise<IDBDatabase> | null = null;
  private videoDirectory: Promise<FileSystemDirectoryHandle> | null = null;
  private reconciled: Promise<void> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = openDatabase().catch((error: unknown) => {
        this.database = null;
        throw error;
      });
    }
    return this.database;
  }

  private directory(): Promise<FileSystemDirectoryHandle> {
    if (!this.videoDirectory) {
      this.videoDirectory = openVideoDirectory().catch((error: unknown) => {
        this.videoDirectory = null;
        throw error;
      });
    }
    return this.videoDirectory;
  }

  private toRecord(metadata: StoredMetadata): VideoRecord {
    return {
      id: metadata.id,
      providerId: this.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      sizeBytes: metadata.sizeBytes,
      durationMs: metadata.durationMs,
      createdAt: metadata.createdAt,
      origin: metadata.origin,
    };
  }

  private async readAll(db: IDBDatabase): Promise<StoredMetadata[]> {
    const store = db.transaction(METADATA_STORE, "readonly").objectStore(METADATA_STORE);
    return requestResult(store.getAll() as IDBRequest<StoredMetadata[]>);
  }

  private async readOne(db: IDBDatabase, id: string): Promise<StoredMetadata | undefined> {
    const store = db.transaction(METADATA_STORE, "readonly").objectStore(METADATA_STORE);
    return requestResult(store.get(id) as IDBRequest<StoredMetadata | undefined>);
  }

  /** Reads and writes in one transaction so a concurrent `remove` is never undone. Resolves whether the row existed. */
  private async update(db: IDBDatabase, id: string, change: (row: StoredMetadata) => StoredMetadata): Promise<boolean> {
    const transaction = db.transaction(METADATA_STORE, "readwrite");
    const store = transaction.objectStore(METADATA_STORE);
    let found = false;
    const request = store.get(id) as IDBRequest<StoredMetadata | undefined>;
    request.onsuccess = () => {
      if (request.result) {
        found = true;
        store.put(change(request.result));
      }
    };
    await transactionDone(transaction);
    return found;
  }

  /** Drops OPFS files without metadata (e.g. a crash mid-upload) and metadata whose file is gone. */
  private async reconcile(): Promise<void> {
    if (!navigator.locks) {
      return;
    }
    const [db, directory] = await Promise.all([this.db(), this.directory()]);
    await navigator.locks.request(WRITE_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) {
        return;
      }
      const rows = await this.readAll(db);
      const referenced = new Set(
        rows.flatMap((row) => (row.thumbnail ? [row.fileName, row.thumbnail.fileName] : [row.fileName]))
      );
      const present = new Set<string>();
      for await (const [name, entry] of directory.entries()) {
        if (entry.kind !== "file") {
          continue;
        }
        if (referenced.has(name)) {
          present.add(name);
        } else {
          await removeFile(directory, name);
        }
      }
      const missing = rows.filter((row) => !present.has(row.fileName));
      const missingThumbnails = rows.filter(
        (row) => present.has(row.fileName) && row.thumbnail && !present.has(row.thumbnail.fileName)
      );
      if (missing.length === 0 && missingThumbnails.length === 0) {
        return;
      }
      const transaction = db.transaction(METADATA_STORE, "readwrite");
      const store = transaction.objectStore(METADATA_STORE);
      for (const row of missing) {
        store.delete(row.id);
      }
      for (const row of missingThumbnails) {
        store.put({ ...row, thumbnail: undefined });
      }
      await transactionDone(transaction);
      for (const row of missing) {
        if (row.thumbnail) {
          await removeFile(directory, row.thumbnail.fileName);
        }
      }
    });
  }

  async list(): Promise<VideoRecord[]> {
    if (!this.reconciled) {
      this.reconciled = this.reconcile().catch(() => undefined);
    }
    await this.reconciled;
    const rows = await this.readAll(await this.db());
    return rows.map((row) => this.toRecord(row));
  }

  async open(id: string): Promise<VideoPlayback> {
    const [db, directory] = await Promise.all([this.db(), this.directory()]);
    const metadata = await this.readOne(db, id);
    const handle = metadata ? await directory.getFileHandle(metadata.fileName).catch(() => null) : null;
    if (!metadata || !handle) {
      throw new Error("This video is no longer stored in the browser");
    }
    const file = await handle.getFile();
    const url = URL.createObjectURL(new Blob([file], { type: metadata.mimeType }));
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  async openThumbnail(id: string): Promise<ReleasableUrl | null> {
    const [db, directory] = await Promise.all([this.db(), this.directory()]);
    const thumbnail = (await this.readOne(db, id))?.thumbnail;
    const handle = thumbnail ? await directory.getFileHandle(thumbnail.fileName).catch(() => null) : null;
    if (!thumbnail || !handle) {
      return null;
    }
    const file = await handle.getFile();
    const url = URL.createObjectURL(new Blob([file], { type: thumbnail.mimeType }));
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  async saveThumbnail(id: string, blob: Blob): Promise<void> {
    const [db, directory] = await Promise.all([this.db(), this.directory()]);
    const thumbnail = storedThumbnail(id, blob);
    await withWriteLock(async () => {
      const handle = await directory.getFileHandle(thumbnail.fileName, { create: true });
      await writeBlob(handle, blob, undefined, undefined);
      if (!(await this.update(db, id, (row) => ({ ...row, thumbnail })))) {
        await removeFile(directory, thumbnail.fileName);
      }
    });
  }

  async save(video: NewVideo, { onProgress, signal }: SaveOptions = {}): Promise<VideoRecord> {
    signal?.throwIfAborted();
    const [db, directory] = await Promise.all([this.db(), this.directory()]);
    const id = nanoid();
    const thumbnail = video.thumbnail ? storedThumbnail(id, video.thumbnail) : undefined;
    const metadata: StoredMetadata = {
      id,
      fileName: id,
      name: video.name,
      mimeType: video.mimeType,
      sizeBytes: video.blob.size,
      durationMs: video.durationMs,
      createdAt: Date.now(),
      thumbnail,
      origin: video.origin,
    };
    return withWriteLock(async () => {
      try {
        if (video.thumbnail && thumbnail) {
          const thumbnailHandle = await directory.getFileHandle(thumbnail.fileName, { create: true });
          await writeBlob(thumbnailHandle, video.thumbnail, undefined, signal);
        }
        const handle = await directory.getFileHandle(metadata.fileName, { create: true });
        await writeBlob(handle, video.blob, onProgress, signal);
        const transaction = db.transaction(METADATA_STORE, "readwrite");
        transaction.objectStore(METADATA_STORE).put(metadata);
        await transactionDone(transaction);
      } catch (error) {
        await removeFile(directory, metadata.fileName);
        if (thumbnail) {
          await removeFile(directory, thumbnail.fileName);
        }
        throw error;
      }
      return this.toRecord(metadata);
    });
  }

  async remove(id: string): Promise<void> {
    const [db, directory] = await Promise.all([this.db(), this.directory()]);
    const metadata = await this.readOne(db, id);
    const transaction = db.transaction(METADATA_STORE, "readwrite");
    transaction.objectStore(METADATA_STORE).delete(id);
    await transactionDone(transaction);
    if (metadata) {
      // A file left behind here is swept by `reconcile` on the next load.
      await removeFile(directory, metadata.fileName);
      if (metadata.thumbnail) {
        await removeFile(directory, metadata.thumbnail.fileName);
      }
    }
  }
}

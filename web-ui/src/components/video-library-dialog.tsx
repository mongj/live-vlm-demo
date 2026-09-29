"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes, PendingUploadCard, UploadCard, VideoCard } from "@/components/video-library-cards";
import { RemoteSourceView } from "@/components/video-library-remote-view";
import { SAVED_VIEW, VideoLibrarySidebar, type LibraryView } from "@/components/video-library-sidebar";
import {
  isClearableSearchTarget,
  VideoLibraryNoMatches,
  VideoLibraryToolbar,
} from "@/components/video-library-toolbar";
import type { StorageUsage, VideoLibraryState } from "@/hooks/use-video-library";
import { cn } from "@/lib/utils";
import { findRemoteSource } from "@/lib/video-library/remote-sources";
import { filterBySearch, normalizeSearchText } from "@/lib/video-library/search";
import { videoKey, type VideoRecord } from "@/lib/video-library/types";
import { useDeferredValue, useRef, useState, type ChangeEvent, type DragEvent } from "react";

type VideoLibraryDialogProps = {
  library: VideoLibraryState;
  activeVideoKey: string | null;
  onSelectVideo: (video: VideoRecord) => void;
  onClearVideo: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function droppedVideoFiles(event: DragEvent<HTMLElement>): File[] {
  return Array.from(event.dataTransfer.files).filter((file) => !file.type || file.type.startsWith("video/"));
}

function StorageMeter({ storage }: { storage: StorageUsage }) {
  const percent = Math.min(100, (storage.usedBytes / storage.quotaBytes) * 100);
  return (
    <div className="flex flex-col gap-1.5">
      <Progress aria-label="Browser storage used" value={percent} />
      <p className="text-xs text-muted-foreground">
        {formatBytes(storage.usedBytes)} of {formatBytes(storage.quotaBytes)} browser storage used
      </p>
    </div>
  );
}

export function VideoLibraryDialog({
  library,
  activeVideoKey,
  onSelectVideo,
  onClearVideo,
  open,
  onOpenChange,
}: VideoLibraryDialogProps) {
  const [dragging, setDragging] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removalTarget, setRemovalTarget] = useState<VideoRecord | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [view, setView] = useState<LibraryView>(SAVED_VIEW);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const searching = normalizeSearchText(deferredQuery) !== "";
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const uploading = library.pendingUploads.length > 0;
  const error = removeError ?? library.uploadError ?? library.listError;
  const showEmptyDropzone =
    view.kind === "saved" &&
    library.status !== "loading" &&
    library.canUpload &&
    library.videos.length === 0 &&
    !uploading;

  const savedVideos = filterBySearch(library.videos, deferredQuery, (video) => [video.name, video.origin?.name]);

  function changeView(next: LibraryView) {
    setView(next);
    setQuery("");
    scrollElement?.scrollTo({ top: 0 });
  }

  function changeQuery(next: string) {
    setQuery(next);
    scrollElement?.scrollTo({ top: 0 });
  }

  function selectAndClose(video: VideoRecord) {
    if (videoKey(video) !== activeVideoKey) {
      onSelectVideo(video);
    }
    onOpenChange(false);
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) {
      return;
    }
    setRemoveError(null);
    const saved = await library.upload(files);
    if (saved.length === 1 && files.length === 1) {
      selectAndClose(saved[0]);
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void uploadFiles(files);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!library.canUpload || uploading) {
      return;
    }
    event.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    changeView(SAVED_VIEW);
    void uploadFiles(droppedVideoFiles(event));
  }

  function requestRemoval(video: VideoRecord) {
    setRemovalTarget(video);
    setConfirmingRemoval(true);
  }

  async function removeVideo(video: VideoRecord) {
    setRemoveError(null);
    if (videoKey(video) === activeVideoKey) {
      onClearVideo();
    }
    try {
      await library.remove(video);
    } catch (removeFailure) {
      setRemoveError(removeFailure instanceof Error ? removeFailure.message : `Unable to delete ${video.name}`);
    }
  }

  function renderSavedVideos() {
    if (library.status === "loading") {
      return (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
        </div>
      );
    }
    if (showEmptyDropzone) {
      return (
        <>
          <UploadCard
            dragging={dragging}
            onClick={() => fileInputRef.current?.click()}
            uploading={false}
            variant="panel"
          />
          {error ? (
            <p className="absolute inset-x-0 bottom-0 bg-popover/90 px-4 py-2 text-xs text-destructive wrap-break-word">
              {error}
            </p>
          ) : null}
        </>
      );
    }
    if (searching && savedVideos.length === 0) {
      return <VideoLibraryNoMatches onClear={() => changeQuery("")} query={deferredQuery} />;
    }
    return (
      <div className="grid grid-cols-1 gap-x-4 gap-y-6 @md:grid-cols-2 @2xl:grid-cols-3" role="list">
        {library.canUpload && !searching ? (
          <div role="listitem">
            <UploadCard dragging={dragging} onClick={() => fileInputRef.current?.click()} uploading={uploading} />
          </div>
        ) : null}
        {searching
          ? null
          : library.pendingUploads.map((pending) => (
              <div key={pending.id} role="listitem">
                <PendingUploadCard onCancel={() => library.cancelUpload(pending.id)} pending={pending} />
              </div>
            ))}
        {savedVideos.map((video) => {
          const key = videoKey(video);
          return (
            <div key={key} role="listitem">
              <VideoCard
                active={key === activeVideoKey}
                onRemove={library.canRemove(video) ? () => requestRemoval(video) : undefined}
                onSelect={() => selectAndClose(video)}
                onStop={onClearVideo}
                video={video}
              />
            </div>
          );
        })}
      </div>
    );
  }

  function renderView() {
    switch (view.kind) {
      case "saved":
        return (
          <>
            {library.status !== "loading" && !showEmptyDropzone ? (
              <VideoLibraryToolbar
                onQueryChange={changeQuery}
                query={query}
                shownCount={savedVideos.length}
                totalCount={library.videos.length}
              />
            ) : null}
            {error && !showEmptyDropzone ? <p className="text-xs text-destructive wrap-break-word">{error}</p> : null}
            {renderSavedVideos()}
          </>
        );
      case "remote": {
        const source = findRemoteSource(view.sourceId);
        if (!source) {
          return null;
        }
        return (
          <RemoteSourceView
            activeVideoKey={activeVideoKey}
            error={removeError}
            key={source.id}
            library={library}
            onRemove={requestRemoval}
            onStop={onClearVideo}
            onQueryChange={changeQuery}
            onUse={selectAndClose}
            query={query}
            scrollElement={scrollElement}
            source={source}
          />
        );
      }
      default: {
        const exhaustive: never = view;
        return exhaustive;
      }
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="h-[min(40rem,calc(100svh-2rem))] grid-rows-[minmax(0,1fr)] p-0 sm:max-w-5xl"
        onEscapeKeyDown={(event) => {
          if (isClearableSearchTarget(event.target)) {
            event.preventDefault();
          }
        }}
      >
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
          <DialogHeader className="p-4 pr-12">
            <DialogTitle>Video library</DialogTitle>
            <DialogDescription>Choose a stored video to stream instead of the camera.</DialogDescription>
          </DialogHeader>
          <Separator />
          <div
            className="flex min-h-0 flex-1 flex-col sm:flex-row"
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            <VideoLibrarySidebar
              className="shrink-0 border-b p-2 sm:w-48 sm:border-r sm:border-b-0 sm:p-3"
              onViewChange={changeView}
              savedCount={library.status === "loading" ? null : library.videos.length}
              view={view}
            />
            <div
              className={cn(
                "@container relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto [scrollbar-gutter:stable]",
                !showEmptyDropzone && "p-4"
              )}
              ref={setScrollElement}
            >
              <input
                accept="video/*"
                aria-hidden
                className="hidden"
                multiple
                onChange={handleFileChange}
                ref={fileInputRef}
                tabIndex={-1}
                type="file"
              />
              {renderView()}
            </div>
          </div>
          {library.storage ? (
            <>
              <Separator />
              <div className="p-4">
                <StorageMeter storage={library.storage} />
              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
      <AlertDialog onOpenChange={setConfirmingRemoval} open={confirmingRemoval}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete video?</AlertDialogTitle>
            <AlertDialogDescription className="wrap-break-word">
              {removalTarget?.name} will be removed from this browser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removalTarget) {
                  void removeVideo(removalTarget);
                }
              }}
              variant="destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

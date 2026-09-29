"use client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { RemoteVideoCard } from "@/components/video-library-cards";
import { VideoLibraryNoMatches, VideoLibraryToolbar } from "@/components/video-library-toolbar";
import { VirtualCardGrid } from "@/components/virtual-card-grid";
import { useRemoteVideos } from "@/hooks/use-remote-videos";
import type { VideoLibraryState } from "@/hooks/use-video-library";
import { remoteVideoKey, type RemoteSource } from "@/lib/video-library/remote-sources";
import { filterBySearch } from "@/lib/video-library/search";
import { videoKey, type VideoRecord } from "@/lib/video-library/types";
import { CloudIcon, CloudOffIcon, RotateCwIcon } from "lucide-react";
import { useDeferredValue } from "react";

type RemoteSourceViewProps = {
  source: RemoteSource;
  library: VideoLibraryState;
  activeVideoKey: string | null;
  onUse: (video: VideoRecord) => void;
  onStop: () => void;
  onRemove: (video: VideoRecord) => void;
  /** Shown above the grid, e.g. a failed removal. */
  error: string | null;
  scrollElement: HTMLElement | null;
  query: string;
  onQueryChange: (query: string) => void;
};

export function RemoteSourceView({
  source,
  library,
  activeVideoKey,
  onUse,
  onStop,
  onRemove,
  error,
  scrollElement,
  query,
  onQueryChange,
}: RemoteSourceViewProps) {
  const remote = useRemoteVideos(source.id);
  const deferredQuery = useDeferredValue(query);

  switch (remote.status) {
    case "loading":
      return (
        <div className="flex justify-center py-6">
          <Spinner className="size-5" />
        </div>
      );
    case "error":
      return (
        <Empty className="border py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CloudOffIcon />
            </EmptyMedia>
            <EmptyTitle>{`Couldn't load ${source.name}`}</EmptyTitle>
            <EmptyDescription className="wrap-break-word">{remote.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={remote.reload} size="sm" type="button" variant="outline">
              <RotateCwIcon />
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      );
    case "ready":
      break;
    default: {
      const exhaustive: never = remote;
      return exhaustive;
    }
  }

  if (remote.videos.length === 0) {
    return (
      <Empty className="border py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudIcon />
          </EmptyMedia>
          <EmptyTitle>{`${source.name} has no videos`}</EmptyTitle>
          <EmptyDescription>Videos added to this source on the server will show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const errors = [error, library.downloadError].filter((message): message is string => Boolean(message));
  const errorMessages = errors.map((message) => (
    <p className="text-xs text-destructive wrap-break-word" key={message}>
      {message}
    </p>
  ));
  const videos = filterBySearch(remote.videos, deferredQuery, (video) => [video.name]);
  const toolbar = (
    <VideoLibraryToolbar
      onQueryChange={onQueryChange}
      query={query}
      shownCount={videos.length}
      totalCount={remote.videos.length}
    />
  );
  if (videos.length === 0) {
    return (
      <>
        {toolbar}
        {errorMessages}
        <VideoLibraryNoMatches onClear={() => onQueryChange("")} query={deferredQuery} />
      </>
    );
  }
  return (
    <>
      {toolbar}
      <VirtualCardGrid
        getKey={remoteVideoKey}
        header={errorMessages}
        items={videos}
        renderItem={(video) => {
          const key = remoteVideoKey(video);
          const stored = library.findDownloaded(video);
          return (
            <RemoteVideoCard
              active={stored !== undefined && videoKey(stored) === activeVideoKey}
              onCancel={() => library.cancelDownload(key)}
              onDownload={() => void library.download(video)}
              onRemove={onRemove}
              onStop={onStop}
              onUse={onUse}
              pending={library.downloads.find((entry) => entry.key === key)}
              stored={stored}
              thumbnailRoot={scrollElement}
              video={video}
            />
          );
        }}
        scrollElement={scrollElement}
      />
    </>
  );
}

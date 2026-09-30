"use client";

import { CameraWorkspace } from "@/components/camera-workspace";
import { DebugPanel } from "@/components/debug-panel";
import { MediaControlBar } from "@/components/media-control-bar";
import { MobilePlayground } from "@/components/mobile-playground";
import { ModelSidebar } from "@/components/model-sidebar";
import { TranscriptPanel } from "@/components/transcript-panel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useHydrated, useIsDesktop } from "@/hooks/use-media-query";
import { usePlayground, type PlaygroundState } from "@/hooks/use-playground";
import { useVideoLibrary } from "@/hooks/use-video-library";
import type { CatalogModel } from "@/lib/catalog";
import type { ReactNode } from "react";
import { useState } from "react";

type PlaygroundProps = {
  initialModels: CatalogModel[];
  initialCatalogError: string | null;
};

function DesktopPlayground({
  playground,
  camera,
  transcript,
  debug,
}: {
  playground: PlaygroundState;
  camera: ReactNode;
  transcript: ReactNode;
  debug: ReactNode | null;
}) {
  return (
    <ResizablePanelGroup className="h-full" orientation="horizontal">
      <ResizablePanel
        className="min-h-0 min-w-0"
        defaultSize={300}
        groupResizeBehavior="preserve-pixel-size"
        id="sidebar"
        maxSize={480}
        minSize={240}
      >
        <ModelSidebar playground={playground} />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel className="min-h-0 min-w-0" id="camera" minSize={320}>
        {camera}
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel
        className="min-h-0 min-w-0"
        defaultSize={380}
        groupResizeBehavior="preserve-pixel-size"
        id="transcript"
        maxSize={560}
        minSize={280}
      >
        {transcript}
      </ResizablePanel>
      {debug ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel
            className="min-h-0 min-w-0"
            defaultSize={320}
            groupResizeBehavior="preserve-pixel-size"
            id="debug"
            maxSize={560}
            minSize={240}
          >
            {debug}
          </ResizablePanel>
        </>
      ) : null}
    </ResizablePanelGroup>
  );
}

export function Playground({ initialModels, initialCatalogError }: PlaygroundProps) {
  const playground = usePlayground(initialModels, initialCatalogError);
  const videoLibrary = useVideoLibrary();
  const [debugOpen, setDebugOpen] = useState(false);
  const hydrated = useHydrated();
  const isDesktop = useIsDesktop();

  const camera = (
    <CameraWorkspace
      activeVideo={playground.activeVideo}
      cameraError={playground.cameraError}
      cameraView={playground.cameraView}
      controlBar={
        <MediaControlBar
          className={isDesktop ? "px-6 pb-6" : "px-3 pb-3"}
          playground={playground}
          videoLibrary={videoLibrary}
        />
      }
      onVideoFileError={playground.reportVideoFileError}
      previewStream={playground.previewStream}
      sessionLive={playground.phase === "live"}
      stageClassName={isDesktop ? undefined : "p-3"}
      videoFileUrl={playground.videoFileUrl}
      videoRef={playground.videoRef}
      videoSource={playground.videoSource}
    />
  );

  const transcript = (
    <TranscriptPanel
      debugOpen={debugOpen}
      density={isDesktop ? "comfortable" : "compact"}
      isStreaming={playground.isStreaming}
      messages={playground.messages}
      modelId={playground.selectedModelId}
      onSend={playground.sendText}
      onToggleDebug={() => setDebugOpen((open) => !open)}
      recoverableError={playground.recoverableError}
      sessionActive={playground.phase === "live"}
    />
  );

  const debug = (
    <DebugPanel
      entries={playground.debugEntries}
      onBack={isDesktop ? undefined : () => setDebugOpen(false)}
    />
  );

  return (
    <div className="h-svh overflow-hidden overscroll-none bg-background text-foreground">
      {!hydrated ? null : isDesktop ? (
        <DesktopPlayground
          camera={camera}
          debug={debugOpen ? debug : null}
          playground={playground}
          transcript={transcript}
        />
      ) : (
        <MobilePlayground
          camera={camera}
          debug={debug}
          debugOpen={debugOpen}
          playground={playground}
          transcript={transcript}
        />
      )}
    </div>
  );
}

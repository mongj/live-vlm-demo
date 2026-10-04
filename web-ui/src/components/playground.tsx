"use client";

import { CameraWorkspace } from "@/components/camera-workspace";
import { DebugPanel } from "@/components/debug-panel";
import { MediaControlBar } from "@/components/media-control-bar";
import { MobilePlayground } from "@/components/mobile-playground";
import { ModelSidebar } from "@/components/model-sidebar";
import { TranscriptPanel } from "@/components/transcript-panel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { DESKTOP_QUERY, useHydrated, useIsDesktop } from "@/hooks/use-media-query";
import { usePlayground, type PlaygroundState } from "@/hooks/use-playground";
import { useVideoLibrary } from "@/hooks/use-video-library";
import type { CatalogModel } from "@/lib/catalog";
import { releaseStageLayout } from "@/lib/stage-fullscreen.mjs";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type PlaygroundProps = {
  initialModels: CatalogModel[];
  initialCatalogError: string | null;
};

function DesktopPlayground({
  playground,
  camera,
  transcript,
  debug,
  retainWideLayout,
}: {
  playground: PlaygroundState;
  camera: ReactNode;
  transcript: ReactNode;
  debug: ReactNode | null;
  retainWideLayout: boolean;
}) {
  // Match panel minimum widths plus the one-pixel separators.
  const minimumWidth = 240 + 320 + 280 + 2 + (debug ? 240 + 1 : 0);
  return (
    <ResizablePanelGroup
      className="h-full min-h-0"
      orientation="horizontal"
      style={{ minWidth: retainWideLayout ? minimumWidth : undefined }}
    >
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
  const viewportIsDesktop = useIsDesktop();
  const [lockedLayout, setLockedLayout] = useState<boolean | null>(null);
  const releaseLayoutFrameRef = useRef<number | null>(null);
  const fullscreenActiveRef = useRef(false);
  const stageActivityRef = useRef({ videoSource: playground.videoSource, sessionActive: playground.sessionActive });
  const isDesktop = lockedLayout ?? viewportIsDesktop;
  const retainWideLayout = isDesktop && !viewportIsDesktop;

  useLayoutEffect(() => {
    stageActivityRef.current = { videoSource: playground.videoSource, sessionActive: playground.sessionActive };
  }, [playground.videoSource, playground.sessionActive]);

  const onFullscreenLayoutLock = useCallback((locked: boolean) => {
    fullscreenActiveRef.current = locked;
    if (releaseLayoutFrameRef.current !== null) {
      cancelAnimationFrame(releaseLayoutFrameRef.current);
      releaseLayoutFrameRef.current = null;
    }
    if (locked) {
      // Never overwrite the original layout with the fullscreen viewport.
      const desktopBeforeFullscreen = window.matchMedia(DESKTOP_QUERY).matches;
      setLockedLayout((current) => current ?? desktopBeforeFullscreen);
    } else {
      // Wait for native exit to settle. If the breakpoint changed, preserve the
      // mounted video until its source/session is inactive or the viewport returns.
      releaseLayoutFrameRef.current = requestAnimationFrame(() => {
        releaseLayoutFrameRef.current = requestAnimationFrame(() => {
          const activity = {
            ...stageActivityRef.current,
            viewportIsDesktop: window.matchMedia(DESKTOP_QUERY).matches,
            fullscreenActive: fullscreenActiveRef.current,
          };
          setLockedLayout((current) => releaseStageLayout(current, activity));
          releaseLayoutFrameRef.current = null;
        });
      });
    }
  }, []);

  useEffect(() => {
    if (!fullscreenActiveRef.current) onFullscreenLayoutLock(false);
  }, [viewportIsDesktop, playground.videoSource, playground.sessionActive, onFullscreenLayoutLock]);

  useEffect(() => () => {
    if (releaseLayoutFrameRef.current !== null) cancelAnimationFrame(releaseLayoutFrameRef.current);
  }, []);

  const camera = (
    <CameraWorkspace
      activeVideo={playground.activeVideo}
      cameraError={playground.cameraError}
      cameraView={playground.cameraView}
      fatalError={playground.fatalError}
      guidance={playground.guidance}
      onFullscreenLayoutLock={onFullscreenLayoutLock}
      sessionNotice={playground.sessionNotice}
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
    <div
      aria-describedby={retainWideLayout ? "retained-layout-notice" : undefined}
      aria-label={retainWideLayout ? "Scrollable wide workspace" : undefined}
      className={`flex h-svh flex-col overscroll-none bg-background text-foreground ${retainWideLayout ? "overflow-x-auto overflow-y-hidden" : "overflow-hidden"}`}
      role={retainWideLayout ? "region" : undefined}
      tabIndex={retainWideLayout ? 0 : undefined}
    >
      {retainWideLayout ? (
        <p className="sticky left-0 w-full shrink-0 border-b bg-background px-3 py-2 text-xs text-muted-foreground" id="retained-layout-notice" role="status">
          Wide layout retained to preserve playback. Scroll sideways to reach video and session controls.
        </p>
      ) : null}
      {!hydrated ? null : isDesktop ? (
        <DesktopPlayground
          camera={camera}
          debug={debugOpen ? debug : null}
          playground={playground}
          retainWideLayout={retainWideLayout}
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

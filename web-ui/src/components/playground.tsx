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
import { useGroupRef, usePanelRef } from "react-resizable-panels";

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
  const groupElementRef = useRef<HTMLDivElement>(null);
  const groupRef = useGroupRef();
  const sidebarRef = usePanelRef();
  const debugRef = usePanelRef();
  const debugWidthRef = useRef(320);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [debugHasWidth, setDebugHasWidth] = useState(false);
  const debugOpen = debug !== null;

  useEffect(() => {
    const panel = debugRef.current;
    const group = groupElementRef.current;
    const sidebar = sidebarRef.current;
    if (!panel || !group || !sidebar) return;

    if (debugOpen) {
      // Keep enough room for an expanded sidebar when opening a wide Debug pane.
      const sidebarMinimum = sidebar.isCollapsed() ? 48 : 240;
      const availableWidth = group.clientWidth - 3 - 320 - 280 - sidebarMinimum;
      panel.resize(Math.max(240, Math.min(debugWidthRef.current, availableWidth)));
    } else {
      const width = panel.getSize().inPixels;
      if (width > 0) debugWidthRef.current = width;
      const layout = groupRef.current?.getLayout();
      if (layout && layout.debug > 0) {
        // Give the space to the flexible video pane, not the pixel-preserved
        // transcript, so the later group shrink cannot squeeze Sidebar closed.
        groupRef.current?.setLayout({ ...layout, camera: layout.camera + layout.debug, debug: 0 });
      }
    }
  }, [debugOpen, debugRef, groupRef, sidebarRef]);

  // Reserve expanded minimums even in a narrow desktop layout. Otherwise collapsed
  // siblings can consume all available width and prevent the sidebar reopening.
  // Keep Debug's space until its collapse has actually completed. Shrinking the
  // group first could force an expanded sidebar closed in a narrow workspace.
  const minimumWidth = 240 + 320 + 280 + 2 + (debugOpen || debugHasWidth ? 240 + 1 : 0);
  return (
    <ResizablePanelGroup
      className="h-full min-h-0"
      elementRef={groupElementRef}
      groupRef={groupRef}
      orientation="horizontal"
      style={{ minWidth: minimumWidth }}
    >
      <ResizablePanel
        className="min-h-0 min-w-0"
        collapsedSize={48}
        collapsible
        defaultSize={48}
        groupResizeBehavior="preserve-pixel-size"
        id="sidebar"
        maxSize={480}
        minSize={240}
        onResize={({ inPixels }) => setSidebarCollapsed(inPixels < 49)}
        panelRef={sidebarRef}
      >
        <ModelSidebar
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => {
            const panel = sidebarRef.current;
            if (panel?.isCollapsed()) panel.expand();
            else panel?.collapse();
          }}
          playground={playground}
        />
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
      {debugOpen ? <ResizableHandle withHandle /> : null}
      {/* Keep the panel IDs stable: adding/removing Debug would restore a separate
          cached group layout, including an outdated sidebar collapse state. */}
      <ResizablePanel
        aria-hidden={!debugOpen}
        className="min-h-0 min-w-0"
        collapsedSize={0}
        collapsible
        defaultSize={0}
        disabled={!debugOpen}
        groupResizeBehavior="preserve-pixel-size"
        id="debug"
        maxSize={560}
        minSize={240}
        onResize={({ inPixels }) => setDebugHasWidth(inPixels > 0)}
        panelRef={debugRef}
      >
        {debug}
      </ResizablePanel>
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
      inputCaption={playground.inputCaption}
      captionsEnabled={playground.captionsEnabled}
      captionSize={playground.captionSize}
      captionBackgroundOpacity={playground.captionBackgroundOpacity}
      onFullscreenLayoutLock={onFullscreenLayoutLock}
      sessionNotice={playground.sessionNotice}
      sessionBadge={playground.sessionStatusBadge}
      sessionStartedAtMonotonicMs={playground.sessionStartedAtMonotonicMs}
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
      speechCapabilities={playground.speechCapabilities}
      typedBusy={playground.typedBusy}
      inputStatus={playground.inputStatus}
      onSend={playground.sendText}
      onToggleDebug={() => setDebugOpen((open) => !open)}
      recoverableError={playground.recoverableError}
      sessionActive={playground.phase === "live"}
    />
  );

  const debug = (
    <DebugPanel
      entries={playground.debugEntries}
      playback={playground.playbackDiagnostics}
      diagnostics={playground.runtimeDiagnostics}
      active={playground.phase === 'live'}
      frameRates={playground.frameRates}
      targetFps={playground.framesPerSecond}
      sessionLogSummary={playground.sessionLogSummary}
      savedSessionLogs={playground.savedSessionLogs}
      includeTranscript={playground.includeTranscript}
      transcriptChoiceLocked={playground.phase !== "idle"}
      onIncludeTranscript={playground.setIncludeTranscript}
      savedLogDownloadStatus={playground.savedLogDownloadStatus}
      onDownloadSavedLog={playground.downloadSavedSessionLog}
      onClearSavedLogs={playground.clearSavedSessionLogs}
      onMarkIssue={playground.markSessionIssue}
      onMarkStateChange={playground.markSessionStateChange}
      stateChangeShortcutHeld={playground.stateChangeShortcutHeld}
      onDownloadLog={playground.downloadSessionLog}
      onBack={isDesktop ? undefined : () => setDebugOpen(false)}
    />
  );

  return (
    <div
      aria-describedby={retainWideLayout ? "retained-layout-notice" : undefined}
      aria-label={retainWideLayout ? "Scrollable wide workspace" : undefined}
      className={`flex h-svh flex-col overscroll-none bg-background text-foreground ${isDesktop ? "overflow-x-auto overflow-y-hidden" : "overflow-hidden"}`}
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

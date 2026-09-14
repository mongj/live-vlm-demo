"use client";

import { CameraWorkspace } from "@/components/camera-workspace";
import { DebugPanel } from "@/components/debug-panel";
import { ModelSidebar } from "@/components/model-sidebar";
import { TranscriptPanel } from "@/components/transcript-panel";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { usePlayground } from "@/hooks/use-playground";
import type { CatalogModel } from "@/lib/catalog";
import { useState } from "react";

type PlaygroundProps = {
  initialModels: CatalogModel[];
  initialCatalogError: string | null;
};

export function Playground({ initialModels, initialCatalogError }: PlaygroundProps) {
  const playground = usePlayground(initialModels, initialCatalogError);
  const [debugOpen, setDebugOpen] = useState(false);

  return (
    <div className="h-svh overflow-hidden overscroll-none bg-background text-foreground">
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
          <CameraWorkspace
            cameraError={playground.cameraError}
            cameraOn={playground.cameraOn}
            cameraView={playground.cameraView}
            micError={playground.micError}
            micOn={playground.micOn}
            onToggleCamera={playground.toggleCamera}
            onToggleMicrophone={playground.toggleMicrophone}
            sessionLive={playground.phase === "live"}
            videoRef={playground.videoRef}
          />
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
          <TranscriptPanel
            debugOpen={debugOpen}
            isStreaming={playground.isStreaming}
            messages={playground.messages}
            onSend={playground.sendText}
            onToggleDebug={() => setDebugOpen((open) => !open)}
            recoverableError={playground.recoverableError}
            sessionActive={playground.phase === "live"}
          />
        </ResizablePanel>
        {debugOpen ? (
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
              <DebugPanel entries={playground.debugEntries} />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
    </div>
  );
}

"use client";

import { ModelSelector } from "@/components/playground-config";
import { SettingsDialog } from "@/components/settings-dialog";
import { Separator } from "@/components/ui/separator";
import type { PlaygroundState } from "@/hooks/use-playground";
import type { ReactNode } from "react";

type MobilePlaygroundProps = {
  playground: PlaygroundState;
  camera: ReactNode;
  transcript: ReactNode;
  debug: ReactNode;
  debugOpen: boolean;
  /** Extra dock height for the step line and operator box, so messages stay visible. */
  dockExtraRem?: number;
};

export function MobilePlayground({
  playground,
  camera,
  transcript,
  debug,
  debugOpen,
  dockExtraRem = 0,
}: MobilePlaygroundProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <ModelSelector
            id="mobile-model-selector"
            playground={playground}
            showLabel={false}
            showRetry={false}
          />
        </div>
        <SettingsDialog playground={playground} />
      </header>
      <Separator />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{camera}</div>
      <Separator />
      <div
        className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        style={{height:`min(calc(var(--playground-mobile-dock-height) + ${dockExtraRem}rem), 60svh)`}}
      >
        {debugOpen ? debug : transcript}
      </div>
    </div>
  );
}

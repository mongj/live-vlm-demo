"use client";

import {
  ModelSelector,
  PlaygroundConfigSections,
  PlaygroundConnectionStatus,
  SessionActionButton,
} from "@/components/playground-config";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import type { PlaygroundState } from "@/hooks/use-playground";

type ModelSidebarProps = {
  playground: PlaygroundState;
};

export function ModelSidebar({ playground }: ModelSidebarProps) {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">VLM Playground</p>
        </div>
        <ThemeToggle />
      </div>
      <Separator />

      <div className="min-w-0 px-4 py-4">
        <ModelSelector playground={playground} />
      </div>

      <Separator />

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <PlaygroundConfigSections playground={playground} />
      </div>

      <Separator />

      <div className="flex flex-col gap-3 px-4 py-4">
        <SessionActionButton className="w-full" playground={playground} />
        <PlaygroundConnectionStatus playground={playground} />
      </div>
    </aside>
  );
}

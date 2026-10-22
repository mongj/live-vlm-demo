"use client";

import {
  ModelSelector,
  PlaygroundConfigSections,
  PlaygroundConnectionStatus,
} from "@/components/playground-config";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PlaygroundState } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import { PanelLeftIcon } from "lucide-react";

type ModelSidebarProps = {
  playground: PlaygroundState;
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export function ModelSidebar({ playground, collapsed, onToggleCollapsed }: ModelSidebarProps) {
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex items-center gap-2 px-2 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-controls="playground-sidebar-content"
              aria-expanded={!collapsed}
              aria-label={toggleLabel}
              className="shrink-0"
              onClick={onToggleCollapsed}
              size="icon"
              type="button"
              variant="ghost"
            >
              <PanelLeftIcon aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{toggleLabel}</TooltipContent>
        </Tooltip>
        <div className={cn("min-w-0 flex-1", collapsed && "hidden")}>
          <p className="truncate text-sm font-medium">VLM Playground</p>
        </div>
        <div className={cn(collapsed && "hidden")}><ThemeToggle /></div>
      </div>
      <div
        className={cn("flex min-h-0 flex-1 flex-col", collapsed && "hidden")}
        id="playground-sidebar-content"
        inert={collapsed}
      >
        <Separator />

        <div className="min-w-0 px-4 py-4">
          <ModelSelector playground={playground} />
        </div>

        <Separator />

        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <PlaygroundConfigSections playground={playground} />
        </div>

        <Separator />

        <div className="px-4 py-4">
          <PlaygroundConnectionStatus playground={playground} />
        </div>
      </div>
    </aside>
  );
}

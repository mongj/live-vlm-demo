"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DebugRawEntry } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon } from "lucide-react";

type DebugPanelProps = {
  entries: DebugRawEntry[];
  onBack?: () => void;
};

const DEBUG_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
};

function formatDebugTimestamp(unixMs: number): string {
  return new Date(unixMs).toLocaleTimeString(undefined, DEBUG_TIME_FORMAT);
}

export function DebugPanel({ entries, onBack }: DebugPanelProps) {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className={cn("flex items-center gap-2", onBack ? "px-3 py-2" : "px-4 py-3")}>
        {onBack ? (
          <Button aria-label="Back to transcript" onClick={onBack} size="icon-sm" type="button" variant="ghost">
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <p className="text-sm font-medium">Debug</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {entries.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No raw adapter output.</p>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            {entries.map((entry) => (
              <div className="flex flex-col gap-1" key={entry.id}>
                <p className="text-xs text-muted-foreground">{formatDebugTimestamp(entry.t)}</p>
                <pre className="wrap-break-word whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                  {entry.raw}
                </pre>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}

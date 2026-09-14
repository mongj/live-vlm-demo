"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { DebugRawEntry } from "@/hooks/use-playground";

type DebugPanelProps = {
  entries: DebugRawEntry[];
};

export function DebugPanel({ entries }: DebugPanelProps) {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="px-4 py-3">
        <p className="text-sm font-medium">Debug</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {entries.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No raw adapter output.</p>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            {entries.map((entry) => (
              <pre
                className="wrap-break-word whitespace-pre-wrap font-mono text-xs text-muted-foreground"
                key={entry.id}
              >
                {entry.raw}
              </pre>
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { REMOTE_SOURCES } from "@/lib/video-library/remote-sources";
import { CloudIcon, LibraryIcon } from "lucide-react";
import type { ReactNode } from "react";

export type LibraryView = { kind: "saved" } | { kind: "remote"; sourceId: string };

export const SAVED_VIEW: LibraryView = { kind: "saved" };

function isSameView(a: LibraryView, b: LibraryView): boolean {
  switch (a.kind) {
    case "saved":
      return b.kind === "saved";
    case "remote":
      return b.kind === "remote" && b.sourceId === a.sourceId;
    default: {
      const exhaustive: never = a;
      return exhaustive;
    }
  }
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="hidden px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground sm:block">{children}</p>;
}

function NavItem({
  active,
  icon,
  label,
  trailing,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      aria-current={active ? "page" : undefined}
      className="shrink-0 justify-start sm:w-full"
      onClick={onClick}
      size="sm"
      type="button"
      variant={active ? "secondary" : "ghost"}
    >
      {icon}
      <span className="truncate">{label}</span>
      {trailing}
    </Button>
  );
}

/** Stacks as a column from `sm` up and collapses to a scrollable row of tabs on narrow screens. */
export function VideoLibrarySidebar({
  view,
  savedCount,
  onViewChange,
  className,
}: {
  view: LibraryView;
  savedCount: number | null;
  onViewChange: (view: LibraryView) => void;
  className?: string;
}) {
  return (
    <nav aria-label="Video sources" className={cn("flex gap-1 overflow-x-auto sm:flex-col sm:overflow-x-visible", className)}>
      <SectionLabel>Saved videos</SectionLabel>
      <NavItem
        active={isSameView(view, SAVED_VIEW)}
        icon={<LibraryIcon />}
        label="All videos"
        onClick={() => onViewChange(SAVED_VIEW)}
        trailing={
          savedCount !== null ? (
            <span className="ml-auto pl-2 text-xs text-muted-foreground tabular-nums">{savedCount}</span>
          ) : null
        }
      />
      <SectionLabel>Remote</SectionLabel>
      {REMOTE_SOURCES.map((source) => {
        const sourceView: LibraryView = { kind: "remote", sourceId: source.id };
        return (
          <NavItem
            active={isSameView(view, sourceView)}
            icon={<CloudIcon />}
            key={source.id}
            label={source.name}
            onClick={() => onViewChange(sourceView)}
          />
        );
      })}
    </nav>
  );
}

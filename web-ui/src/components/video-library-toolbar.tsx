"use client";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { SearchIcon, SearchXIcon, XIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

const SEARCH_INPUT_ATTRIBUTE = "data-video-library-search";

/** Lets the dialog keep Escape for clearing a non-empty search before it closes. */
export function isClearableSearchTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.hasAttribute(SEARCH_INPUT_ATTRIBUTE) && target.value !== "";
}

function videoCount(count: number): string {
  return `${count} ${count === 1 ? "video" : "videos"}`;
}

type VideoLibraryToolbarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  shownCount: number;
  totalCount: number;
};

/** Sticks to the top of the scrolling panel; the negative margins cancel the panel's `p-4` so cards don't peek above it. */
export function VideoLibraryToolbar({ query, onQueryChange, shownCount, totalCount }: VideoLibraryToolbarProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && query) {
      onQueryChange("");
    }
  }

  return (
    <div className="sticky -top-4 z-10 -mx-4 -mt-4 -mb-2 flex items-center gap-3 bg-popover px-4 pt-4 pb-2">
      <InputGroup className="max-w-72">
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput
          aria-label="Search videos"
          data-video-library-search=""
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search videos"
          type="text"
          value={query}
        />
        {query ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton aria-label="Clear search" onClick={() => onQueryChange("")} size="icon-xs">
              <XIcon />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
      <p className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {shownCount === totalCount ? videoCount(totalCount) : `${shownCount} of ${videoCount(totalCount)}`}
      </p>
    </div>
  );
}

export function VideoLibraryNoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <Empty className="py-10">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon />
        </EmptyMedia>
        <EmptyTitle>No videos match</EmptyTitle>
        <EmptyDescription className="wrap-break-word">{`Nothing matches “${query.trim()}”.`}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onClear} size="sm" type="button" variant="outline">
          Clear search
        </Button>
      </EmptyContent>
    </Empty>
  );
}

"use client";

import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useState, type ReactNode } from "react";

/** Must match the grid classes below: `gap-x-4`, `gap-y-6`, and the `@md` / `@2xl` column breakpoints. */
const COLUMN_GAP_PX = 16;
const ROW_GAP_PX = 24;
const COLUMN_BREAKPOINTS_REM = [
  { minRem: 42, columns: 3 },
  { minRem: 28, columns: 2 },
];
const ROW_GRID_CLASS = "grid grid-cols-1 gap-x-4 @md:grid-cols-2 @2xl:grid-cols-3";
/** Gap between thumbnail and title, plus two title lines and the meta line; rows are measured once rendered. */
const ESTIMATED_TEXT_HEIGHT_PX = 68;
const OVERSCAN_ROWS = 1;

type Geometry = { width: number; offsetTop: number };

function columnsFor(width: number): number {
  const remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return COLUMN_BREAKPOINTS_REM.find((breakpoint) => width >= breakpoint.minRem * remPx)?.columns ?? 1;
}

/** Tracks the list's width and its offset inside the scroll element, which moves when the header resizes. */
function useListGeometry(
  list: HTMLElement | null,
  header: HTMLElement | null,
  scrollElement: HTMLElement | null
): Geometry | null {
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  useEffect(() => {
    if (!list || !header || !scrollElement) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const offsetTop =
        list.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;
      const next = { width: list.clientWidth, offsetTop: Math.round(offsetTop) };
      setGeometry((current) =>
        current && current.width === next.width && current.offsetTop === next.offsetTop ? current : next
      );
    });
    observer.observe(list);
    observer.observe(header);
    return () => observer.disconnect();
  }, [header, list, scrollElement]);

  return geometry;
}

type VirtualCardGridProps<T> = {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** The element that scrolls; it must be the grid's `@container` so the breakpoints line up. */
  scrollElement: HTMLElement | null;
  /** Rendered above the grid, inside the same scroll area. */
  header: ReactNode;
};

/** A card grid that mounts only the rows near the viewport. */
export function VirtualCardGrid<T>({ items, getKey, renderItem, scrollElement, header }: VirtualCardGridProps<T>) {
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const [headerElement, setHeaderElement] = useState<HTMLDivElement | null>(null);
  const geometry = useListGeometry(list, headerElement, scrollElement);
  const columns = geometry ? columnsFor(geometry.width) : 1;
  const rowCount = Math.ceil(items.length / columns);
  const cardWidth = geometry ? (geometry.width - COLUMN_GAP_PX * (columns - 1)) / columns : 0;
  const scrollMargin = geometry?.offsetTop ?? 0;

  // eslint-disable-next-line react-hooks/incompatible-library -- the compiler must skip this component; only DOM refs receive virtualizer functions.
  const virtualizer = useVirtualizer({
    count: geometry ? rowCount : 0,
    getScrollElement: () => scrollElement,
    estimateSize: () => (cardWidth * 9) / 16 + ESTIMATED_TEXT_HEIGHT_PX + ROW_GAP_PX,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
  });

  return (
    <>
      <div className="flex flex-col gap-4" ref={setHeaderElement}>
        {header}
      </div>
      <div className="relative shrink-0" ref={setList} role="list" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const rowItems = items.slice(row.index * columns, (row.index + 1) * columns);
          return (
            <div
              className={cn("absolute inset-x-0 top-0", ROW_GRID_CLASS, row.index < rowCount - 1 && "pb-6")}
              data-index={row.index}
              key={row.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
            >
              {rowItems.map((item, column) => (
                <div
                  aria-posinset={row.index * columns + column + 1}
                  aria-setsize={items.length}
                  key={getKey(item)}
                  role="listitem"
                >
                  {renderItem(item)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

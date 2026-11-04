"use client";

import type { SessionRunView } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useRef } from "react";

function formatClip(seconds: number | null): string | null {
  if (seconds === null) return null;
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${(whole % 60).toString().padStart(2, "0")}`;
}

/** Step list with the tracker's estimate highlighted. An estimate from replies, never a verified state. */
export function StepProgress({
  steps,
  run,
  live,
  compact = false,
}: {
  steps: string[];
  run: SessionRunView | null;
  live: boolean;
  compact?: boolean;
}) {
  const tracking = live && !!run?.trackerEnabled;
  const current = tracking ? run.currentStep : -1;
  const transitions = tracking ? run.transitions : [];
  const started = current >= 0;
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // Scroll only this short list, keeping the estimate visible as it moves.
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !item) return;
    const itemBox = item.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    if (itemBox.top < listBox.top) list.scrollTop -= listBox.top - itemBox.top;
    else if (itemBox.bottom > listBox.bottom) list.scrollTop += itemBox.bottom - listBox.bottom;
  }, [current]);
  const summary = !live
    ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}`
    : !tracking ? "Tracker off"
    : started ? `Step ${current + 1} of ${steps.length}` : "Waiting for the first reply";

  return (
    <details className="group/steps shrink-0 border-b" data-slot="step-progress" open={compact ? undefined : true}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 font-medium" role="status" aria-live="polite" aria-atomic="true">{summary}</span>
        {started ? <span className="min-w-0 truncate text-muted-foreground group-open/steps:hidden">{steps[current]}</span> : null}
        <ChevronDownIcon aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-open/steps:rotate-180" />
      </summary>
      <ol className="max-h-44 overflow-y-auto px-2 pb-2 text-xs" ref={listRef}>
        {steps.map((step, index) => {
          const isCurrent = index === current;
          const passed = index < current;
          const transition = transitions.findLast(row => row.to === index);
          const clip = transition ? formatClip(transition.decidedClipS ?? transition.clipS) : null;
          return (
            <li
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1",
                isCurrent ? "bg-primary/10 font-medium text-foreground ring-1 ring-primary/40" : "text-muted-foreground"
              )}
              key={`${index}-${step}`}
            >
              <span aria-hidden className="flex size-4 shrink-0 items-center justify-center tabular-nums">
                {passed ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1 wrap-break-word">{step}</span>
              {clip ? (
                <span className="shrink-0 font-normal text-muted-foreground tabular-nums" title={transition?.mapped === null ? "Moved on elapsed time, with no matching words in the reply" : "A reply matched this step"}>
                  {clip}{transition?.mapped === null ? " · time" : ""}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {live && tracking ? <p className="px-3 pb-2 text-[10px] text-muted-foreground">Estimated from the model&apos;s replies. Not confirmation that a step happened.</p> : null}
    </details>
  );
}

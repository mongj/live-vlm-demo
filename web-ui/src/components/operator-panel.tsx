"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useId, useState } from "react";

/** Wizard of Oz input: a human types what the assistant says. Never reaches a real model. */
export function OperatorPanel({
  live,
  steps,
  voice,
  onVoiceChange,
  onSend,
  onOpenWindow,
  compact = false,
}: {
  live: boolean;
  steps: string[];
  voice: boolean;
  onVoiceChange: (enabled: boolean) => void;
  onSend: (text: string) => boolean;
  /** Opens the separate operator window. False when the browser blocked it. */
  onOpenWindow?: () => boolean;
  compact?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [nextStep, setNextStep] = useState(0);
  const [blocked, setBlocked] = useState(false);

  function send(text: string) {
    return text.trim() ? onSend(text) : false;
  }

  function sendStep(index: number) {
    if (send(steps[index])) setNextStep(Math.min(steps.length, index + 1));
  }

  return (
    <section
      aria-label="Operator reply, Wizard of Oz"
      className="mb-2 rounded-lg border border-debug-warning/25 bg-debug-warning/10 p-2"
      data-slot="operator-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium" htmlFor={`${id}-reply`}>Operator reply · Wizard of Oz</Label>
        <div className="flex shrink-0 items-center gap-1.5">
          <Label className="text-[10px] font-normal text-muted-foreground" htmlFor={`${id}-voice`}>Browser voice</Label>
          <Switch checked={voice} id={`${id}-voice`} onCheckedChange={onVoiceChange} size="sm" />
        </div>
      </div>
      {compact ? null : (
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          A person plays the model here. What you send appears as the assistant&apos;s reply and is logged as operator text.
        </p>
      )}
      {!compact && onOpenWindow ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Button onClick={() => setBlocked(!onOpenWindow())} size="xs" type="button" variant="outline">Open operator window</Button>
          <span className="text-[10px] text-muted-foreground">
            {blocked ? "The browser blocked it. Open /operator in a new window." : "Moves this box to a second window, out of a participant's sight."}
          </span>
        </div>
      ) : null}
      {steps.length > 0 ? (
        <div className="mt-1.5 flex min-w-0 items-center gap-1 overflow-x-auto" role="group" aria-label="Send a listed step as the reply">
          <span className="shrink-0 text-[10px] text-muted-foreground">Say step</span>
          {steps.map((step, index) => (
            <Button
              aria-label={`Say step ${index + 1}: ${step}`}
              className={cn("shrink-0 tabular-nums", index === nextStep && "border-debug-warning/60")}
              disabled={!live}
              key={`${index}-${step}`}
              onClick={() => sendStep(index)}
              size="xs"
              title={step}
              type="button"
              variant="outline"
            >
              {index + 1}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="mt-1.5 flex items-end gap-1.5">
        <Textarea
          className="min-h-8 flex-1 bg-background py-1 md:text-xs dark:bg-background"
          disabled={!live}
          id={`${id}-reply`}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (send(draft)) setDraft("");
          }}
          placeholder={live ? "Type the model's reply" : "Start a session to reply as the model"}
          rows={1}
          value={draft}
        />
        <Button
          disabled={!live || !draft.trim()}
          onClick={() => { if (send(draft)) setDraft(""); }}
          size="sm"
          type="button"
        >
          Send
        </Button>
      </div>
    </section>
  );
}

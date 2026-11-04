"use client";

import { ConfigSection } from "@/components/config-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { PlaygroundState } from "@/hooks/use-playground";
import {
  buildProcedurePrompt,
  DEFAULT_CHECK_IN_TEXT,
  DEFAULT_STANDING_INSTRUCTION,
  MAX_CHECK_IN_INTERVAL,
  MIN_CHECK_IN_INTERVAL,
  parseSteps,
} from "@/lib/procedure.mjs";
import type { ReactNode } from "react";

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? <p className="text-xs text-destructive" id={id}>{message}</p> : null;
}

function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <Label className="block" htmlFor={id}>{label}</Label>
        <p className="text-xs wrap-break-word text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} id={id} onCheckedChange={onChange} />
    </div>
  );
}

export function ProcedureSection({ playground, idPrefix = "procedure" }: { playground: PlaygroundState; idPrefix?: string }) {
  const { procedure, procedureErrors: errors, setProcedure, sessionActive, silentLibraryVideo } = playground;
  const steps = parseSteps(procedure.stepsText);
  const locked = sessionActive;
  const id = (name: string) => `${idPrefix}-${name}`;
  const invalid = Object.keys(errors).length > 0;

  return (
    <ConfigSection
      defaultOpen={false}
      subtitle={!procedure.enabled ? "Off" : invalid ? "On · needs attention" : `On · ${steps.length} ${steps.length === 1 ? "step" : "steps"}`}
      title="Procedure Mode"
    >
      <div className="flex min-w-0 flex-col gap-4 overflow-x-hidden px-4.5 pt-3.5 pb-4.5">
        <SwitchRow
          checked={procedure.enabled}
          description="Builds the prompt from the task and steps, and sends your request before a library video starts."
          disabled={locked}
          id={id("enabled")}
          label="Use procedure mode"
          onChange={enabled => setProcedure({enabled})}
        />
        {procedure.enabled ? (
          <>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={id("task")}>Task name</Label>
              <Input
                aria-describedby={errors.task ? id("task-error") : undefined}
                aria-invalid={Boolean(errors.task)}
                disabled={locked}
                id={id("task")}
                onChange={event => setProcedure({task:event.target.value})}
                placeholder="Fold a paper plane"
                type="text"
                value={procedure.task}
              />
              <FieldError id={id("task-error")} message={errors.task} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={id("steps")}>Ordered steps</Label>
              <Textarea
                aria-describedby={errors.steps ? id("steps-error") : id("steps-hint")}
                aria-invalid={Boolean(errors.steps)}
                className="max-h-48 min-h-24"
                disabled={locked}
                id={id("steps")}
                onChange={event => setProcedure({stepsText:event.target.value})}
                placeholder={"Fold the paper in half\nOpen it and fold the corners in\nFold the wings down"}
                value={procedure.stepsText}
              />
              <p className="text-xs text-muted-foreground" id={id("steps-hint")}>One step per line. {steps.length} {steps.length === 1 ? "step" : "steps"} listed.</p>
              <FieldError id={id("steps-error")} message={errors.steps} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={id("instruction")}>Standing instruction</Label>
                {procedure.instruction !== DEFAULT_STANDING_INSTRUCTION ? (
                  <Button disabled={locked} onClick={() => setProcedure({instruction:DEFAULT_STANDING_INSTRUCTION})} size="xs" type="button" variant="ghost">Reset</Button>
                ) : null}
              </div>
              <Textarea
                aria-describedby={errors.instruction ? id("instruction-error") : id("instruction-hint")}
                aria-invalid={Boolean(errors.instruction)}
                disabled={locked}
                id={id("instruction")}
                onChange={event => setProcedure({instruction:event.target.value})}
                value={procedure.instruction}
              />
              <p className="text-xs text-muted-foreground" id={id("instruction-hint")}>Sent as typed speech. A library video waits at its first frame until this is sent.</p>
              <FieldError id={id("instruction-error")} message={errors.instruction} />
            </div>
            <SwitchRow
              checked={procedure.checkIns}
              description="Asks the model on a fixed schedule. This can raise later-step guidance, but it adds speech."
              disabled={locked}
              id={id("check-ins")}
              label="Scheduled check-ins"
              onChange={checkIns => setProcedure({checkIns})}
            />
            {procedure.checkIns ? (
              <div className="flex min-w-0 flex-col gap-3 border-l pl-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor={id("interval")}>Every (seconds)</Label>
                  <Input
                    aria-describedby={errors.checkInInterval ? id("interval-error") : undefined}
                    aria-invalid={Boolean(errors.checkInInterval)}
                    disabled={locked}
                    id={id("interval")}
                    max={MAX_CHECK_IN_INTERVAL}
                    min={MIN_CHECK_IN_INTERVAL}
                    onChange={event => setProcedure({checkInInterval:Number(event.target.value)})}
                    step={1}
                    type="number"
                    value={procedure.checkInInterval}
                  />
                  <FieldError id={id("interval-error")} message={errors.checkInInterval} />
                </div>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={id("check-in-text")}>Check-in text</Label>
                    {procedure.checkInText !== DEFAULT_CHECK_IN_TEXT ? (
                      <Button disabled={locked} onClick={() => setProcedure({checkInText:DEFAULT_CHECK_IN_TEXT})} size="xs" type="button" variant="ghost">Reset</Button>
                    ) : null}
                  </div>
                  <Textarea
                    aria-describedby={errors.checkInText ? id("check-in-text-error") : undefined}
                    aria-invalid={Boolean(errors.checkInText)}
                    disabled={locked}
                    id={id("check-in-text")}
                    onChange={event => setProcedure({checkInText:event.target.value})}
                    value={procedure.checkInText}
                  />
                  <FieldError id={id("check-in-text-error")} message={errors.checkInText} />
                  <p className="text-xs text-muted-foreground">Skipped while the model is replying, you are speaking or the video is paused. Your microphone is ignored while one is being sent.</p>
                </div>
              </div>
            ) : null}
            <SwitchRow
              checked={procedure.tracker}
              description="Estimates the current step from the model's replies, in order. It never sees reference times."
              disabled={locked}
              id={id("tracker")}
              label="Step tracker"
              onChange={tracker => setProcedure({tracker})}
            />
            {procedure.tracker ? (
              <div className="flex min-w-0 flex-col gap-3 border-l pl-3">
                <SwitchRow
                  checked={procedure.showOnlyNewSteps}
                  description="Hides other replies from captions and the transcript. The session log keeps them."
                  id={id("show-only")}
                  label="Show only new steps"
                  onChange={showOnlyNewSteps => setProcedure({showOnlyNewSteps})}
                />
                <SwitchRow
                  checked={procedure.speakOnlyNewSteps}
                  description="Plays a reply only once the step estimate moves to a new step, so speech can start a little late."
                  id={id("speak-only")}
                  label="Speak only new steps"
                  onChange={speakOnlyNewSteps => setProcedure({speakOnlyNewSteps})}
                />
              </div>
            ) : null}
            <details className="min-w-0 text-xs text-muted-foreground">
              <summary className="cursor-pointer py-1">Preview prompt</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap wrap-break-word">
                {buildProcedurePrompt({task:procedure.task, steps, silentVideo:silentLibraryVideo})}
              </pre>
              <p className="mt-1">The English, session time and voice reference instructions are added after this. The answer-only-the-current-request instruction is left out.</p>
            </details>
          </>
        ) : null}
      </div>
    </ConfigSection>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DebugRawEntry, PlaygroundState } from "@/hooks/use-playground";
import type { PlaybackDiagnostics } from "@/lib/playback-diagnostics.mjs";
import type { RuntimeDiagnosticEntry } from "@/lib/runtime-diagnostics.mjs";
import type { FrameRateSnapshot } from "@/lib/frame-rates";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, DownloadIcon, FlagIcon } from "lucide-react";
import { useState } from "react";

type DebugPanelProps = {
  entries: DebugRawEntry[];
  playback: PlaybackDiagnostics;
  diagnostics: RuntimeDiagnosticEntry[];
  active: boolean;
  frameRates: FrameRateSnapshot;
  targetFps: number;
  sessionLogSummary: PlaygroundState["sessionLogSummary"];
  onMarkIssue: () => void;
  onDownloadLog: () => void;
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

const METRIC_LABELS: Record<string, string> = {
  prefill_ms: 'Prefill', generate_ms: 'Generation', wall_clock_ms: 'Model chunk time',
  cost_llm_ms: 'Language model', kv_cache_length: 'Context tokens', n_tokens: 'Text tokens',
  n_tts_tokens: 'Speech tokens', vision_slices: 'Vision slices', vision_tokens: 'Vision tokens',
};

const DEBUG_CATEGORIES = {
  input: { label: "Input", className: "border-debug-input/25 bg-debug-input/10 text-debug-input" },
  output: { label: "Output", className: "border-debug-output/25 bg-debug-output/10 text-debug-output" },
  status: { label: "Status", className: "border-border bg-muted text-muted-foreground" },
  warning: { label: "Warning", className: "border-debug-warning/25 bg-debug-warning/10 text-debug-warning" },
  error: { label: "Error", className: "border-destructive/25 bg-destructive/10 text-destructive" },
} as const;
type DebugCategory = keyof typeof DEBUG_CATEGORIES;
const DEBUG_FILTERS = ["all", "input", "output", "status", "warning", "error"] as const;
type DebugFilter = (typeof DEBUG_FILTERS)[number];

function eventCategory(event: string): DebugCategory {
  switch (event) {
    case "input_sent":
    case "asr_complete":
    // Typed-input speech preparation is input, not the model's spoken output.
    case "tts_complete":
      return "input";
    case "model_output":
      return "output";
    case "input_drop":
      return "warning";
    case "asr_failed":
    case "tts_failed":
    case "error":
      return "error";
    default:
      return "status";
  }
}

export function DebugPanel({ entries, playback, diagnostics, active, frameRates, targetFps, sessionLogSummary, onMarkIssue, onDownloadLog, onBack }: DebugPanelProps) {
  const [filter, setFilter] = useState<DebugFilter>("all");
  const latest = diagnostics.at(-1)?.snapshot;
  const filteredDiagnostics = diagnostics.filter(entry => filter === "all" || eventCategory(entry.snapshot.event) === filter);
  const showRawOutput = filter === "all" || filter === "output";
  const noFilteredEvents = filter !== "all" && filteredDiagnostics.length === 0 && (!showRawOutput || entries.length === 0);
  const frameRateReadings = (
    <section className="space-y-1" aria-label="Frame transport rates">
      <p>Configured browser target: {targetFps} FPS</p>
      <p>Browser captured: {frameRates.captured?.toFixed(1) ?? 'Unavailable'} FPS</p>
      <p>Browser submitted: {frameRates.submitted?.toFixed(1) ?? 'Unavailable'} FPS</p>
      <p>Upstream MiniCPM sent: {frameRates.upstream?.toFixed(1) ?? 'Unavailable'} FPS</p>
    </section>
  );
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className={cn("flex min-w-0 flex-wrap items-center gap-1", onBack ? "px-3 py-2" : "px-4 py-3")}>
        {onBack ? (
          <Button aria-label="Back to transcript" onClick={onBack} size="icon-sm" type="button" variant="ghost">
            <ArrowLeftIcon />
          </Button>
        ) : null}
        <p className="shrink-0 text-sm font-medium">Debug</p>
        <Select value={filter} onValueChange={value => {
          const next = DEBUG_FILTERS.find(option => option === value);
          if (next) setFilter(next);
        }}>
          <SelectTrigger aria-label="Filter debug events" className="ml-auto max-w-28 text-xs" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {DEBUG_FILTERS.map(value => (
                <SelectItem key={value} value={value}>
                  {value === "all" ? "All events" : DEBUG_CATEGORIES[value].label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button aria-label="Mark issue" title="Mark issue in this session" disabled={!active || !sessionLogSummary}
          onClick={onMarkIssue} size="icon-sm" type="button" variant="ghost">
          <FlagIcon aria-hidden />
        </Button>
        <Button aria-label="Download session log" title="Download session log" disabled={!sessionLogSummary}
          onClick={onDownloadLog} size="icon-sm" type="button" variant="ghost">
          <DownloadIcon aria-hidden />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {sessionLogSummary ? (
          <div className="border-b px-4 pb-3 text-xs text-muted-foreground">
            <details>
              <summary className="cursor-pointer py-1">Session log · {sessionLogSummary.eventCount} events · {sessionLogSummary.issueCount} issues</summary>
              <p>{sessionLogSummary.terminal ? "Session ended" : "Current session"} · diagnostic events only; no media or transcript recording.</p>
            </details>
            {sessionLogSummary.downloadStatus !== "Not downloaded" ? (
              <p className="break-words" role="status">{sessionLogSummary.downloadStatus}</p>
            ) : null}
          </div>
        ) : null}
        {latest ? (
          <section aria-label="MiniCPM runtime diagnostics" className="space-y-2 border-b px-4 pb-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">MiniCPM · {active ? 'latest report' : 'last session'}</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
              <dt>Reported state</dt><dd>{latest.stage}</dd>
              <dt>Session elapsed</dt><dd>{(latest.elapsed_ms / 1000).toFixed(1)} s</dd>
              <dt>Input packets / frames sent</dt><dd>{latest.input.packets} / {latest.input.frames}</dd>
              <dt>Input audio sent (before padding)</dt><dd>{(latest.input.audio_ms / 1000).toFixed(2)} s</dd>
              <dt>Input audio dropped</dt><dd>{(latest.input.dropped_audio_ms / 1000).toFixed(2)} s</dd>
              <dt>Text / audio chunks received</dt><dd>{latest.output.text_chunks} / {latest.output.audio_chunks}</dd>
              <dt>Model audio received</dt><dd>{(latest.output.audio_ms / 1000).toFixed(2)} s</dd>
              <dt>Voice captions / typed speech</dt><dd>{latest.speech.transcription ? 'Ready' : 'Off'} / {latest.speech.typed_input ? 'Ready' : 'Off'}</dd>
              {latest.speech.asr_ms !== undefined ? <><dt>Last transcription request</dt><dd>{latest.speech.asr_ms.toFixed(0)} ms</dd></> : null}
              {latest.speech.tts_ms !== undefined ? <><dt>Last typed-speech request</dt><dd>{latest.speech.tts_ms.toFixed(0)} ms</dd></> : null}
            </dl>
            <p className="font-medium">Last model-reported metrics{latest.chunk_index !== undefined ? ` · chunk ${latest.chunk_index}` : ''}</p>
            {latest.metrics ? <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
              {Object.entries(latest.metrics).map(([key, value]) => <div className="contents" key={key}>
                <dt>{METRIC_LABELS[key]}</dt><dd>{key.endsWith('_ms') ? `${value.toFixed(1)} ms` : value}</dd>
              </div>)}
            </dl> : <p>Not reported.</p>}
            {frameRateReadings}
            <details>
              <summary className="cursor-pointer py-1">Recent events ({filter === "all" ? diagnostics.length : `${filteredDiagnostics.length} of ${diagnostics.length}`}, latest 120)</summary>
              <div className="flex max-h-48 flex-col gap-1 overflow-auto">
                {filteredDiagnostics.map((entry, index) => {
                  const category = DEBUG_CATEGORIES[eventCategory(entry.snapshot.event)];
                  return <details key={`${entry.receivedAt}-${entry.snapshot.elapsed_ms}-${entry.snapshot.event}-${index}`}>
                    <summary className="cursor-pointer break-words">
                      <Badge variant="outline" className={cn("mr-1", category.className)}>{category.label}</Badge>
                      {formatDebugTimestamp(entry.receivedAt)} · {entry.snapshot.event} · {entry.snapshot.stage}
                    </summary>
                    <pre className="whitespace-pre-wrap break-words">{JSON.stringify(entry.snapshot, null, 2)}</pre>
                  </details>;
                })}
              </div>
            </details>
          </section>
        ) : (
          <div className="border-b px-4 pb-3 text-xs text-muted-foreground">{frameRateReadings}</div>
        )}
        <div className="space-y-1 border-b px-4 pb-3 text-xs text-muted-foreground" aria-label="Playback diagnostics">
          <p>Audio received: {(playback.receivedBytes / 48_000).toFixed(1)} s</p>
          <p>Sent to playback: {(playback.queuedBytes / 48_000).toFixed(1)} s</p>
          <p>Discarded after interruption or mute: {(playback.discardedBytes / 48_000).toFixed(1)} s</p>
          <p>Interruptions: {playback.interruptions} · Microphone: {playback.micInterruptions}</p>
          <p>Last interruption: {playback.lastReason ?? "None"}</p>
          <p>Queued audio may be stopped before it is heard. Counters contain no recordings.</p>
        </div>
        {noFilteredEvents ? (
          <p className="px-4 py-3 text-xs text-muted-foreground" role="status">No {DEBUG_CATEGORIES[filter].label} events in recent history.</p>
        ) : null}
        {filter === "all" && entries.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No raw adapter output.</p>
        ) : showRawOutput && entries.length > 0 ? (
          <div className="flex flex-col gap-3 p-4">
            {entries.map((entry) => (
              <div className="flex flex-col gap-1" key={entry.id}>
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="outline" className={DEBUG_CATEGORIES.output.className}>Raw / Output</Badge>
                  <p className="text-xs text-muted-foreground">{formatDebugTimestamp(entry.t)}</p>
                </div>
                <pre className="wrap-break-word whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                  {entry.raw}
                </pre>
              </div>
            ))}
          </div>
        ) : null}
      </ScrollArea>
    </aside>
  );
}

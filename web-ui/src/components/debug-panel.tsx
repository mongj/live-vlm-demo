"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DebugRawEntry, PlaygroundState } from "@/hooks/use-playground";
import type { PlaybackDiagnostics } from "@/lib/playback-diagnostics.mjs";
import type { RuntimeDiagnosticEntry } from "@/lib/runtime-diagnostics.mjs";
import type { FrameRateSnapshot } from "@/lib/frame-rates";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, DownloadIcon, FlagIcon, ScanLineIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

type DebugPanelProps = {
  entries: DebugRawEntry[];
  playback: PlaybackDiagnostics;
  diagnostics: RuntimeDiagnosticEntry[];
  active: boolean;
  frameRates: FrameRateSnapshot;
  targetFps: number;
  sessionLogSummary: PlaygroundState["sessionLogSummary"];
  savedSessionLogs?: PlaygroundState["savedSessionLogs"];
  savedLogDownloadStatus?: string;
  includeTranscript?: boolean;
  transcriptChoiceLocked?: boolean;
  onIncludeTranscript?: (enabled:boolean) => void;
  onDownloadSavedLog?: (startedAt:number) => void;
  onClearSavedLogs?: () => void;
  onMarkIssue: () => void;
  onMarkStateChange: () => void;
  stateChangeShortcutHeld: boolean;
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

function DebugActionHint({label,children}:{label:string;children:ReactNode}) {
  return <Tooltip><TooltipTrigger asChild><span className="inline-flex">{children}</span></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

export function DebugPanel({ entries, playback, diagnostics, active, frameRates, targetFps, sessionLogSummary, savedSessionLogs, savedLogDownloadStatus, includeTranscript, transcriptChoiceLocked, onIncludeTranscript, onDownloadSavedLog, onClearSavedLogs, onMarkIssue, onMarkStateChange, stateChangeShortcutHeld, onDownloadLog, onBack }: DebugPanelProps) {
  const [filter, setFilter] = useState<DebugFilter>("all");
  const [issueKeyHeld, setIssueKeyHeld] = useState(false);
  const [issuePointerHeld, setIssuePointerHeld] = useState(false);
  const canMarkIssue = active && !!sessionLogSummary && !sessionLogSummary.terminal;
  useEffect(() => {
    const releasePointer = () => setIssuePointerHeld(false);
    const release = () => { setIssueKeyHeld(false); releasePointer(); };
    const releaseKey = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") setIssueKeyHeld(false);
    };
    window.addEventListener("blur", release);
    window.addEventListener("keyup", releaseKey);
    window.addEventListener("pointerup", releasePointer);
    window.addEventListener("pointercancel", releasePointer);
    return () => {
      window.removeEventListener("blur", release);
      window.removeEventListener("keyup", releaseKey);
      window.removeEventListener("pointerup", releasePointer);
      window.removeEventListener("pointercancel", releasePointer);
    };
  }, []);
  const issueCount = sessionLogSummary?.issueCount ?? 0;
  const changeCount = sessionLogSummary?.stateChangeCount ?? 0;
  const downloadHint = sessionLogSummary?.terminal
    ? "Session ended · download from Saved session logs below"
    : sessionLogSummary ? "Download a snapshot of the current session" : "Start a session to collect a log";
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
          <DebugActionHint label="Back to transcript">
          <Button aria-label="Back to transcript" onClick={onBack} size="icon-sm" type="button" variant="ghost">
            <ArrowLeftIcon />
          </Button>
          </DebugActionHint>
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
        <DebugActionHint label="Mark issue">
        <Button aria-label="Mark issue" disabled={!canMarkIssue}
          className={cn("transition-none", (issueKeyHeld || issuePointerHeld) && canMarkIssue
              ? "bg-debug-input/10 text-debug-input hover:text-debug-input [&_svg]:fill-current"
              : "text-muted-foreground hover:text-muted-foreground")}
          onPointerDown={event => { if (event.button === 0) setIssuePointerHeld(true); }}
          onPointerLeave={() => setIssuePointerHeld(false)}
          onKeyDown={event => {
            if (event.key !== " " && event.key !== "Enter") return;
            if (event.repeat) event.preventDefault();
            else setIssueKeyHeld(true);
          }}
          onBlur={() => { setIssueKeyHeld(false); setIssuePointerHeld(false); }}
          onClick={onMarkIssue} size="icon-sm" type="button" variant="ghost">
          <FlagIcon aria-hidden fill="none" />
        </Button>
        </DebugActionHint>
        <DebugActionHint label="Mark change · Shift+M">
          <Button aria-label="Mark change" aria-keyshortcuts="Shift+M" disabled={!canMarkIssue}
            className={cn("transition-none active:bg-debug-input/10 active:text-debug-input",stateChangeShortcutHeld
              ? "bg-debug-input/10 text-debug-input" : "text-muted-foreground")}
            onKeyDown={event=>{if (event.repeat && (event.key === " " || event.key === "Enter")) event.preventDefault();}}
            onClick={onMarkStateChange} size="icon-sm" type="button" variant="ghost">
            <ScanLineIcon aria-hidden />
          </Button>
        </DebugActionHint>
        <DebugActionHint label={`Download current session log · ${downloadHint}`}>
        <Button aria-label="Download current session log" disabled={!sessionLogSummary || sessionLogSummary.terminal}
          onClick={onDownloadLog} size="icon-sm" type="button" variant="ghost">
          <DownloadIcon aria-hidden />
        </Button>
        </DebugActionHint>
        <p role="status" aria-live="polite" aria-atomic="true" className="w-full text-xs text-debug-input">
          {[issueCount > 0 ? `Issue #${issueCount} marked` : "",changeCount > 0 ? `Change #${changeCount} marked` : ""].filter(Boolean).join(" · ")}
        </p>
        {sessionLogSummary?.terminal ? <p className="w-full text-xs text-muted-foreground">{downloadHint}</p> : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {savedSessionLogs ? (
          <section aria-label="Saved session logs" className="border-b px-4 pb-3 text-xs text-muted-foreground">
            <details>
              <summary className="cursor-pointer py-1">Saved session logs · {savedSessionLogs.logs.length} of 2</summary>
              <p>Latest two completed logs in this browser only. No audio or video. Downloads are manual.</p>
              <label className="my-2 flex items-center gap-2">
                <input type="checkbox" checked={includeTranscript ?? false} disabled={transcriptChoiceLocked} onChange={event=>onIncludeTranscript?.(event.target.checked)} />
                Include transcript in session log
              </label>
              <p>Choose before starting. Saves displayed user/assistant text and timestamps locally; speech captions may be inaccurate.</p>
              <p role="status" className="py-1 break-words">
                {savedSessionLogs.storage === "loading" ? "Loading browser logs…"
                  : savedSessionLogs.storage === "saving" ? "Updating browser storage…"
                  : savedSessionLogs.storage === "memory" ? "Some logs are memory-only · browser storage could not save all logs; download before closing."
                  : savedSessionLogs.storage === "clear_failed" ? "Cleared from memory · browser storage could not be cleared; retry before refreshing."
                  : "Saved in this browser · same app origin; browser data may be cleared or evicted."}
              </p>
              {savedSessionLogs.logs.map(log=>(
                <div key={log.startedAt} className="flex min-w-0 flex-wrap items-center justify-between gap-1 py-1">
                  <div className="min-w-0 break-words">
                    <time dateTime={new Date(log.startedAt).toISOString()}>{new Date(log.startedAt).toLocaleString()}</time>
                    <p>{log.events.length} events · {log.issueCount} issues · {log.stateChangeCount} changes{log.transcriptEnabled ? " · transcript included" : " · no transcript"}{log.truncated || log.transcript?.truncated ? " · truncated" : ""}</p>
                  </div>
                  <Button aria-label={`Download session log from ${new Date(log.startedAt).toLocaleString()}`} onClick={()=>onDownloadSavedLog?.(log.startedAt)} size="sm" type="button" variant="outline">Download</Button>
                </div>
              ))}
              <Button onClick={onClearSavedLogs} disabled={savedSessionLogs.storage === "loading"} size="sm" type="button" variant="outline" className="mt-1">Clear saved logs</Button>
              {savedLogDownloadStatus ? <p role="status" className="mt-1 break-words">{savedLogDownloadStatus}</p> : null}
            </details>
          </section>
        ) : null}
        {sessionLogSummary ? (
          <div className="border-b px-4 pb-3 text-xs text-muted-foreground">
            <details>
              <summary className="cursor-pointer py-1">Session log · {sessionLogSummary.eventCount} events · {sessionLogSummary.issueCount} issues · {sessionLogSummary.stateChangeCount} changes</summary>
              <p>{sessionLogSummary.terminal ? "Session ended" : "Current session"} · {sessionLogSummary.transcriptEnabled ? "transcript included" : "diagnostics only"}; no audio or video recording.</p>
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
            {latest.native ? <details>
              <summary className="cursor-pointer py-1">Input/output tracing</summary>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
                <dt>Latest native output</dt><dd>{latest.native.kind}</dd>
                <dt>Consecutive listen events</dt><dd>{latest.native.listen_streak}</dd>
                {latest.native.since_content_ms !== undefined ? <><dt>Since text/audio received</dt><dd>{(latest.native.since_content_ms/1000).toFixed(1)} s</dd></> : null}
                <dt>Matched input packet</dt><dd>{latest.native.matched ? `#${latest.native.input_sequence}` : "Unknown"}</dd>
                {latest.native.matched ? <>
                  <dt>Forced listen for that input</dt><dd>{latest.native.force_listen ? latest.native.force_source : "No"}</dd>
                  <dt>Input send → output received</dt><dd>{((latest.native.input_age_ms ?? 0)/1000).toFixed(2)} s</dd>
                </> : null}
              </dl>
              <p>Sampled latest output; send-to-output includes transport, queue and processing. A listen event can also end a reply.</p>
            </details> : null}
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

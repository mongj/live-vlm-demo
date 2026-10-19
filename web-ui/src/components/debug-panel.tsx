"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DebugRawEntry } from "@/hooks/use-playground";
import type { PlaybackDiagnostics } from "@/lib/playback-diagnostics.mjs";
import type { RuntimeDiagnosticEntry } from "@/lib/runtime-diagnostics.mjs";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon } from "lucide-react";

type DebugPanelProps = {
  entries: DebugRawEntry[];
  playback: PlaybackDiagnostics;
  diagnostics: RuntimeDiagnosticEntry[];
  active: boolean;
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

export function DebugPanel({ entries, playback, diagnostics, active, onBack }: DebugPanelProps) {
  const latest = diagnostics.at(-1)?.snapshot;
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
            <p>Sent is not proof of model comprehension. Model timings exclude parts of the network and playback path.</p>
            <details>
              <summary className="cursor-pointer py-1">Recent events ({diagnostics.length}, latest 120)</summary>
              <div className="max-h-48 overflow-auto space-y-1">
                {diagnostics.map((entry, index) => <details key={`${entry.receivedAt}-${index}`}>
                  <summary className="cursor-pointer break-words">{formatDebugTimestamp(entry.receivedAt)} · {entry.snapshot.event} · {entry.snapshot.stage}</summary>
                  <pre className="whitespace-pre-wrap break-words">{JSON.stringify(entry.snapshot, null, 2)}</pre>
                </details>)}
              </div>
            </details>
          </section>
        ) : null}
        <div className="space-y-1 border-b px-4 pb-3 text-xs text-muted-foreground" aria-label="Playback diagnostics">
          <p>Audio received: {(playback.receivedBytes / 48_000).toFixed(1)} s</p>
          <p>Sent to playback: {(playback.queuedBytes / 48_000).toFixed(1)} s</p>
          <p>Discarded after interruption: {(playback.discardedBytes / 48_000).toFixed(1)} s</p>
          <p>Interruptions: {playback.interruptions} · Microphone: {playback.micInterruptions}</p>
          <p>Last interruption: {playback.lastReason ?? "None"}</p>
          <p>Queued audio may be stopped before it is heard. Counters contain no recordings.</p>
        </div>
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

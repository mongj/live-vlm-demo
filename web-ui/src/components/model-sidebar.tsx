"use client";

import { ConnectionStatus } from "@/components/connection-status";
import { SchemaForm } from "@/components/schema-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { PlaygroundState } from "@/hooks/use-playground";

type ModelSidebarProps = {
  playground: PlaygroundState;
};

export function ModelSidebar({ playground }: ModelSidebarProps) {
  const {
    catalogStatus,
    catalogError,
    models,
    selectedModelId,
    selectedModel,
    config,
    sessionActive,
    canStart,
    phase,
    sessionId,
    recoverableError,
    fatalError,
    cameraError,
    setSelectedModelId,
    setConfigValue,
    reloadCatalog,
    start,
    stop,
  } = playground;

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">VLM Playground</p>
        </div>
        <ThemeToggle />
      </div>
      <Separator />

      <div className="min-w-0 space-y-3 px-4 py-4">
        <div className="min-w-0 space-y-1.5 overflow-hidden">
          <Label className="block truncate" htmlFor="model-selector">
            Model
          </Label>
          <Select
            disabled={sessionActive || catalogStatus !== "ready"}
            onValueChange={setSelectedModelId}
            value={selectedModelId || undefined}
          >
            <SelectTrigger className="w-full min-w-0" id="model-selector">
              <SelectValue placeholder={catalogStatus === "loading" ? "Loading…" : "Select a model"} />
            </SelectTrigger>
            <SelectContent align="start" position="popper">
              {models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {catalogStatus === "error" ? (
          <Button className="w-full" onClick={reloadCatalog} type="button" variant="outline">
            Retry Catalog
          </Button>
        ) : null}
      </div>

      <Separator />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="min-w-0 px-4 pt-4 pb-2">
          <p className="truncate text-sm font-medium">Configuration</p>
          <p className="truncate text-xs text-muted-foreground">Applied when the Session starts</p>
        </div>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="min-w-0 overflow-x-hidden px-4 pb-4">
            {selectedModel ? (
              <SchemaForm
                disabled={sessionActive}
                onChange={setConfigValue}
                schema={selectedModel.config_schema}
                values={config}
              />
            ) : (
              <p className="text-xs text-muted-foreground">
                {catalogError ?? "Load the Catalog to configure a model."}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>

      <Separator />

      <div className="space-y-3 px-4 py-4">
        {sessionActive ? (
          <Button className="w-full" key="stop" onClick={stop} type="button" variant="destructive">
            {phase === "live" ? "Stop Session" : "Cancel"}
          </Button>
        ) : (
          <Button
            className="w-full"
            disabled={!canStart}
            key="start"
            onClick={() => void start()}
            type="button"
            variant="default"
          >
            Start Session
          </Button>
        )}
        <ConnectionStatus
          cameraError={cameraError}
          catalogError={catalogError}
          catalogStatus={catalogStatus}
          fatalError={fatalError}
          phase={phase}
          recoverableError={recoverableError}
          sessionId={sessionId}
        />
      </div>
    </aside>
  );
}

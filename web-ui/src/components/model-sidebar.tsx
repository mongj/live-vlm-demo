"use client";

import { ConnectionStatus } from "@/components/connection-status";
import { SchemaForm } from "@/components/schema-form";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { PlaygroundState } from "@/hooks/use-playground";
import { DEFAULT_GATEWAY_ADDRESS } from "@/lib/gateway";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

type ModelSidebarProps = {
  playground: PlaygroundState;
};

function ConfigSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="group/collapsible flex min-w-0 flex-col" defaultOpen>
      <CollapsibleTrigger className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 bg-transparent px-4 py-4 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <ChevronDownIcon className="shrink-0 self-center text-muted-foreground transition-transform duration-200 in-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ModelSidebar({ playground }: ModelSidebarProps) {
  const {
    catalogStatus,
    catalogError,
    models,
    selectedModelId,
    selectedModel,
    config,
    serverAddress,
    sessionActive,
    canStart,
    phase,
    sessionId,
    recoverableError,
    fatalError,
    cameraError,
    setSelectedModelId,
    setConfigValue,
    setServerAddress,
    commitServerAddress,
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
        <div className="min-w-0 space-y-1.5 overflow-visible">
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

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
        <ConfigSection subtitle="Applied when the Session starts" title="Model Configuration">
          <div className="min-w-0 overflow-x-hidden px-4.5 pt-3.5 pb-4.5">
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
        </ConfigSection>

        <Separator />

        <ConfigSection subtitle="Used for Catalog and Session" title="Server Configuration">
          <div className="min-w-0 space-y-1.5 overflow-x-hidden px-4.5 pt-3.5 pb-4.5">
            <Label className="block truncate" htmlFor="server-address">
              Server Address
            </Label>
            <Input
              autoComplete="off"
              disabled={sessionActive}
              id="server-address"
              onBlur={commitServerAddress}
              onChange={(event) => setServerAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder={DEFAULT_GATEWAY_ADDRESS}
              spellCheck={false}
              type="text"
              value={serverAddress}
            />
          </div>
        </ConfigSection>
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

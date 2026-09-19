"use client";

import { ConnectionStatus } from "@/components/connection-status";
import { SchemaForm } from "@/components/schema-form";
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
import { MAX_FRAMES_PER_SECOND, MIN_FRAMES_PER_SECOND } from "@/lib/capture";
import { DEFAULT_GATEWAY_ADDRESS } from "@/lib/gateway";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

type PlaygroundConfigProps = {
  playground: PlaygroundState;
};

export function ConfigSection({
  title,
  subtitle,
  children,
  defaultOpen = true,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Collapsible className="group/collapsible flex min-w-0 flex-col" defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 bg-transparent px-4 py-4 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <ChevronDownIcon className="shrink-0 self-center text-muted-foreground transition-transform duration-200 in-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="min-w-0">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function ModelSelector({
  playground,
  id = "model-selector",
  showLabel = true,
  showRetry = true,
}: PlaygroundConfigProps & {
  id?: string;
  showLabel?: boolean;
  showRetry?: boolean;
}) {
  const {
    catalogStatus,
    models,
    selectedModelId,
    sessionActive,
    setSelectedModelId,
  } = playground;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1.5 overflow-visible">
        {showLabel ? (
          <Label className="block truncate" htmlFor={id}>
            Model
          </Label>
        ) : (
          <Label className="sr-only" htmlFor={id}>
            Model
          </Label>
        )}
        <Select
          disabled={sessionActive || catalogStatus !== "ready"}
          onValueChange={setSelectedModelId}
          value={selectedModelId || undefined}
        >
          <SelectTrigger className="w-full min-w-0" id={id}>
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
      {showRetry ? <CatalogRetryButton playground={playground} /> : null}
    </div>
  );
}

export function CatalogRetryButton({ playground }: PlaygroundConfigProps) {
  if (playground.catalogStatus !== "error") {
    return null;
  }

  return (
    <Button className="w-full" onClick={playground.reloadCatalog} type="button" variant="outline">
      Retry Catalog
    </Button>
  );
}

export function ModelConfigSection({ playground }: PlaygroundConfigProps) {
  const { selectedModel, catalogError, sessionActive, config, setConfigValue } = playground;

  return (
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
  );
}

export function ClientConfigSection({
  playground,
  id = "frames-per-second",
}: PlaygroundConfigProps & {
  id?: string;
}) {
  const { framesPerSecond, setFramesPerSecond } = playground;

  return (
    <ConfigSection defaultOpen={false} subtitle="Applied to the camera feed" title="Client Configuration">
      <div className="flex min-w-0 flex-col gap-1.5 overflow-x-hidden px-4.5 pt-3.5 pb-4.5">
        <Label className="block truncate" htmlFor={id}>
          Frames Per Second
        </Label>
        <Input
          id={id}
          max={MAX_FRAMES_PER_SECOND}
          min={MIN_FRAMES_PER_SECOND}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              return;
            }
            const next = Number.parseInt(raw, 10);
            if (Number.isFinite(next)) {
              setFramesPerSecond(next);
            }
          }}
          step={1}
          type="number"
          value={framesPerSecond}
        />
      </div>
    </ConfigSection>
  );
}

export function ServerConfigSection({
  playground,
  id = "server-address",
}: PlaygroundConfigProps & {
  id?: string;
}) {
  const { sessionActive, serverAddress, setServerAddress, commitServerAddress } = playground;

  return (
    <ConfigSection defaultOpen={false} subtitle="Used for Catalog and Session" title="Server Configuration">
      <div className="flex min-w-0 flex-col gap-1.5 overflow-x-hidden px-4.5 pt-3.5 pb-4.5">
        <Label className="block truncate" htmlFor={id}>
          Server Address
        </Label>
        <Input
          autoComplete="off"
          disabled={sessionActive}
          id={id}
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
  );
}

export function PlaygroundConfigSections({
  playground,
  framesPerSecondId = "frames-per-second",
  serverAddressId = "server-address",
}: PlaygroundConfigProps & {
  framesPerSecondId?: string;
  serverAddressId?: string;
}) {
  return (
    <div className="min-h-0 min-w-0">
      <ModelConfigSection playground={playground} />
      <Separator />
      <ClientConfigSection id={framesPerSecondId} playground={playground} />
      <Separator />
      <ServerConfigSection id={serverAddressId} playground={playground} />
    </div>
  );
}

export function SessionActionButton({
  playground,
  className,
  size = "default",
}: PlaygroundConfigProps & {
  className?: string;
  size?: "default" | "sm";
}) {
  const { sessionActive, canStart, phase, start, stop } = playground;

  if (sessionActive) {
    return (
      <Button className={className} key="stop" onClick={stop} size={size} type="button" variant="destructive">
        {phase === "live" ? "Stop Session" : "Cancel"}
      </Button>
    );
  }

  return (
    <Button
      className={className}
      disabled={!canStart}
      key="start"
      onClick={() => void start()}
      size={size}
      type="button"
      variant="default"
    >
      Start Session
    </Button>
  );
}

export function PlaygroundConnectionStatus({ playground }: PlaygroundConfigProps) {
  return (
    <ConnectionStatus
      cameraError={playground.cameraError}
      catalogError={playground.catalogError}
      catalogStatus={playground.catalogStatus}
      fatalError={playground.fatalError}
      phase={playground.phase}
      recoverableError={playground.recoverableError}
      sessionId={playground.sessionId}
    />
  );
}

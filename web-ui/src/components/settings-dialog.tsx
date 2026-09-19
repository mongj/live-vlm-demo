"use client";

import { CatalogRetryButton, PlaygroundConfigSections } from "@/components/playground-config";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import type { PlaygroundState } from "@/hooks/use-playground";
import { SettingsIcon } from "lucide-react";
import { useState } from "react";

type SettingsDialogProps = {
  playground: PlaygroundState;
};

export function SettingsDialog({ playground }: SettingsDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button aria-label="Open settings" size="icon-sm" type="button" variant="ghost">
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[min(40rem,calc(100svh-2rem))] p-0 sm:max-w-md">
        <div className="flex max-h-[min(40rem,calc(100svh-2rem))] flex-col overflow-hidden">
          <DialogHeader className="p-4 pr-12">
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Model, client, and server options.</DialogDescription>
          </DialogHeader>
          <Separator />
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <p className="truncate text-sm font-medium">Appearance</p>
            <ThemeToggle />
          </div>
          <Separator />
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            <PlaygroundConfigSections
              framesPerSecondId="settings-frames-per-second"
              playground={playground}
              serverAddressId="settings-server-address"
            />
            {playground.catalogStatus === "error" ? (
              <div className="px-4.5 pt-1.5 pb-4.5">
                <CatalogRetryButton playground={playground} />
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

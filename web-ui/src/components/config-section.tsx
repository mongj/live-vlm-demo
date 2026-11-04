"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

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

"use client";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { InputGroupAddon } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TranscriptMessage } from "@/hooks/use-playground";
import { cn } from "@/lib/utils";
import { typedInputPolicy } from "@/lib/model-input-policy.mjs";
import type { SpeechCapabilities } from "@/lib/protocol";
import { inputStatusLabels } from "@/lib/input-feedback.mjs";
import { BugIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";

export type TranscriptDensity = "comfortable" | "compact";

function TranscriptAutoScroll({ latestUserId, sessionActive }: { latestUserId?: string; sessionActive: boolean }) {
  const { scrollToBottom, scrollRef, state } = useStickToBottomContext();

  useEffect(() => {
    // A new instruction resumes following after reading older messages.
    if (sessionActive) void scrollToBottom({ animation: "instant" });
  }, [latestUserId, sessionActive, scrollToBottom]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    // Composer/status changes resize the viewport without resizing its content.
    const observer = new ResizeObserver(() => {
      if (state.isAtBottom) void scrollToBottom({ animation: "instant", preserveScrollPosition: true });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [scrollRef, scrollToBottom, state]);

  return null;
}

type TranscriptPanelProps = {
  modelId?: string;
  messages: TranscriptMessage[];
  isStreaming: boolean;
  sessionActive: boolean;
  recoverableError: string | null;
  debugOpen: boolean;
  density?: TranscriptDensity;
  speechCapabilities?: SpeechCapabilities | null;
  typedBusy?: boolean;
  inputStatus?: string;
  onToggleDebug: () => void;
  onSend: (text: string) => Promise<boolean>;
};

function headerClass(density: TranscriptDensity): string {
  switch (density) {
    case "comfortable":
      return "px-4 py-3";
    case "compact":
      return "px-3 py-2";
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function conversationContentClass(density: TranscriptDensity): string {
  switch (density) {
    case "comfortable":
      return "gap-4 p-4";
    case "compact":
      return "gap-2 p-2";
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function emptyStateClass(density: TranscriptDensity): string | undefined {
  switch (density) {
    case "comfortable":
      return undefined;
    case "compact":
      return "gap-1 p-2";
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function emptyStateIcon(density: TranscriptDensity): ReactNode {
  switch (density) {
    case "comfortable":
      return <MessageSquareIcon className="size-5" />;
    case "compact":
      return undefined;
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function composerWrapClass(density: TranscriptDensity): string {
  switch (density) {
    case "comfortable":
      return "border-t border-border p-3";
    case "compact":
      return "border-t border-border p-2";
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function textareaClass(density: TranscriptDensity): string {
  switch (density) {
    case "comfortable":
      return "min-h-12";
    case "compact":
      return "field-sizing-fixed h-full min-h-0 max-h-none overflow-hidden py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function textareaRows(density: TranscriptDensity): number | undefined {
  switch (density) {
    case "comfortable":
      return undefined;
    case "compact":
      return 1;
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function promptInputClass(density: TranscriptDensity): string | undefined {
  switch (density) {
    case "comfortable":
      return undefined;
    case "compact":
      return "[&_[data-slot=input-group]]:h-12 [&_[data-slot=input-group]]:flex-row [&_[data-slot=input-group]]:overflow-hidden [&_[data-slot=input-group]]:has-[>textarea]:h-12";
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

function ComposerSubmit({
  density,
  sessionActive,
  isStreaming,
}: {
  density: TranscriptDensity;
  sessionActive: boolean;
  isStreaming: boolean;
}) {
  const submit = (
    <PromptInputSubmit
      disabled={!sessionActive}
      status={isStreaming ? "submitted" : "ready"}
    />
  );

  switch (density) {
    case "compact":
      return (
        <InputGroupAddon align="inline-end" className="pr-1.5 has-[>button]:mr-0">
          {submit}
        </InputGroupAddon>
      );
    case "comfortable":
      return <PromptInputFooter className="justify-end">{submit}</PromptInputFooter>;
    default: {
      const exhaustive: never = density;
      return exhaustive;
    }
  }
}

export function TranscriptPanel({
  modelId,
  messages,
  isStreaming,
  sessionActive,
  recoverableError,
  debugOpen,
  density = "comfortable",
  speechCapabilities,
  typedBusy = false,
  inputStatus,
  onToggleDebug,
  onSend,
}: TranscriptPanelProps) {
  const debugLabel = debugOpen ? "Hide debug panel" : "Show debug panel";
  const inputPolicy = typedInputPolicy(modelId, sessionActive, speechCapabilities, typedBusy);
  const [draft, setDraft] = useState('');

  async function handleSubmit(message: PromptInputMessage) {
    const text = message.text;
    if (!text.trim() || !inputPolicy.enabled) {
      return;
    }
    const accepted = await onSend(text);
    if (accepted) setDraft(current => current === text ? '' : current);
  }

  const composer = (
    <>
      {inputPolicy.notice ? (
        <p className="mb-2 text-xs text-muted-foreground" role="note">{inputPolicy.notice}</p>
      ) : null}
      {recoverableError && sessionActive ? (
        <p className="mb-2 truncate text-xs text-destructive">{recoverableError}</p>
      ) : null}
      {inputStatus && sessionActive ? <p className="mb-1 text-xs text-muted-foreground" role="status">{inputStatus}</p> : null}
      <PromptInput className={promptInputClass(density)} maxFiles={0} onSubmit={handleSubmit}>
        <PromptInputTextarea
          className={textareaClass(density)}
          disabled={!inputPolicy.enabled}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder={inputPolicy.notice ? "Typed input unavailable" : sessionActive ? "Ask about what the video shows" : "Start a Session to send a message"}
          rows={textareaRows(density)}
        />
        <ComposerSubmit density={density} isStreaming={typedBusy || (modelId !== 'minicpm-o-4-5' && isStreaming)} sessionActive={inputPolicy.enabled} />
      </PromptInput>
    </>
  );

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className={cn("flex items-center justify-between gap-3", headerClass(density))}>
        <p className="text-sm font-medium">Transcript</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={debugLabel}
              aria-pressed={debugOpen}
              onClick={onToggleDebug}
              size="icon-sm"
              type="button"
              variant={debugOpen ? "secondary" : "ghost"}
            >
              <BugIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{debugLabel}</TooltipContent>
        </Tooltip>
      </div>
      <Conversation className="min-h-0">
        <TranscriptAutoScroll latestUserId={messages.findLast(message => message.role === "user")?.id} sessionActive={sessionActive} />
        <ConversationContent className={conversationContentClass(density)}>
          {messages.length === 0 ? (
            <ConversationEmptyState
              className={emptyStateClass(density)}
              description={
                sessionActive
                  ? inputPolicy.notice ? "Watching the video feed for a response" : "Speak or send a message"
                  : "Start a session to see the live transcript."
              }
              icon={emptyStateIcon(density)}
              title="No messages"
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.source ? <div className="text-blue-700 dark:text-blue-200">
                    <p className="mb-1 text-[10px] font-medium">You · {message.source}</p>
                    <p className="whitespace-pre-wrap wrap-anywhere">{message.text || (message.streaming ? '…' : '')}</p>
                    {message.status && message.status in inputStatusLabels ? <p className="mt-1 text-[10px] opacity-80">{message.statusDetail ?? inputStatusLabels[message.status as keyof typeof inputStatusLabels]}</p> : null}
                  </div> : <MessageResponse isAnimating={message.streaming}>
                    {message.text || (message.streaming ? "…" : "")}
                  </MessageResponse>}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest message" title="Scroll to latest message" />
      </Conversation>
      <div className={composerWrapClass(density)}>{composer}</div>
    </aside>
  );
}

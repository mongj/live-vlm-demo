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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TranscriptMessage } from "@/hooks/use-playground";
import { BugIcon, MessageSquareIcon } from "lucide-react";

type TranscriptPanelProps = {
  messages: TranscriptMessage[];
  isStreaming: boolean;
  sessionActive: boolean;
  recoverableError: string | null;
  debugOpen: boolean;
  onToggleDebug: () => void;
  onSend: (text: string) => Promise<void>;
};

export function TranscriptPanel({
  messages,
  isStreaming,
  sessionActive,
  recoverableError,
  debugOpen,
  onToggleDebug,
  onSend,
}: TranscriptPanelProps) {
  const debugLabel = debugOpen ? "Hide debug panel" : "Show debug panel";

  function handleSubmit(message: PromptInputMessage) {
    const text = message.text.trim();
    if (!text) {
      return;
    }
    void onSend(text);
  }

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
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
        <ConversationContent className="gap-4 p-4">
          {messages.length === 0 ? (
            <ConversationEmptyState
              description={
                sessionActive
                  ? "Send a message"
                  : "Start a session to see the live transcript."
              }
              icon={<MessageSquareIcon className="size-5" />}
              title="No messages"
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  <MessageResponse isAnimating={message.streaming}>
                    {message.text || (message.streaming ? "…" : "")}
                  </MessageResponse>
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="border-t border-border p-3">
        {recoverableError && sessionActive ? (
          <p className="mb-2 text-xs text-destructive">{recoverableError}</p>
        ) : null}
        <PromptInput maxFiles={0} onSubmit={handleSubmit}>
          <PromptInputTextarea
            className="min-h-12"
            disabled={!sessionActive}
            placeholder={sessionActive ? "Ask about what the camera sees" : "Start a Session to send a message"}
          />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit
              disabled={!sessionActive}
              status={isStreaming ? "submitted" : "ready"}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </aside>
  );
}

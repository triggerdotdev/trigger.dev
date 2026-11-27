"use client";

// The Ask AI answer inside the search dialog, loaded with the first Ask from search.

import { useChat } from "@ai-sdk/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Answer } from "./ask-answer";
import { askChat } from "./ask-chat";

export function AskInline({
  question,
  onContinue,
}: {
  question: string;
  onContinue: (streaming: boolean) => void;
}) {
  const { messages, status, error } = useChat({ chat: askChat });
  const answer = messages.findLast((m) => m.role === "assistant");
  const busy = status === "submitted" || status === "streaming";
  return (
    <div className="max-h-[60vh] overflow-y-auto border-t">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-fd-popover/95 px-4 py-2 backdrop-blur">
        <Sparkles className="size-3.5 text-fd-primary" />
        <span className="text-xs font-medium text-fd-muted-foreground">Ask AI</span>
        <button
          type="button"
          onClick={() => onContinue(busy)}
          className="ms-auto inline-flex items-center gap-1.5 rounded-md border bg-fd-secondary px-2 py-1 text-xs font-medium text-fd-secondary-foreground hover:bg-fd-accent"
        >
          Continue in Ask AI
          <ArrowRight className="size-3.5" />
        </button>
      </div>
      <div className="px-4 py-3">
        {answer ? (
          <Answer m={answer} streaming={busy} question={question} />
        ) : (
          !error && <p className="text-sm text-fd-muted-foreground">Looking through the docs…</p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-md border border-[var(--callout-warning)] px-3 py-2 text-sm"
          >
            {error.message || "Ask AI couldn't answer. Try again."}
          </p>
        )}
      </div>
    </div>
  );
}

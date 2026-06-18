import type { UIMessage } from "@ai-sdk/react";
import { Spinner } from "~/components/primitives/Spinner";
import { MessageBubble } from "~/components/runs/v3/agent/AgentMessageView";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";

// The shared MessageBubble renders `step-start` parts as a dashed "step"
// separator — useful in the run inspector / playground, just noise in this
// simple chat. Drop them before rendering (reference preserved when there are
// none, so memoization still holds for those messages).
function stripStepParts(message: UIMessage): UIMessage {
  if (!message.parts?.some((p) => p.type === "step-start")) return message;
  return { ...message, parts: message.parts.filter((p) => p.type !== "step-start") };
}

// Renders the conversation with the shared agent message renderer — the same
// MessageBubble the run inspector and playground use, so agent output looks
// identical everywhere.
export function DashboardAgentMessages({
  messages,
  isThinking,
  error,
}: {
  messages: UIMessage[];
  isThinking: boolean;
  error?: Error;
}) {
  const rootRef = useAutoScrollToBottom([messages, isThinking]);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <div ref={rootRef} className="space-y-4 p-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={stripStepParts(message)} />
        ))}
        {isThinking && (
          <div className="flex items-center gap-2 text-sm text-text-dimmed">
            <Spinner className="size-3" />
            Thinking…
          </div>
        )}
        {error && (
          <div className="rounded border border-error/30 bg-error/10 px-3 py-2">
            <span className="text-xs text-error">{error.message}</span>
          </div>
        )}
      </div>
    </div>
  );
}

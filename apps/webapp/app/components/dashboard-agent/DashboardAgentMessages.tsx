import type { UIMessage } from "@ai-sdk/react";
import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { memo } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { MessageBubble, renderPart } from "~/components/runs/v3/agent/AgentMessageView";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import { ViewBlocks } from "./view-catalog";

// "thinking" — the turn is submitted but nothing has come back yet.
// "working" — the turn is streaming: text, or (more often) tool calls, which can
// run for a while with no visible output.
export type TurnActivity = "thinking" | "working";

const ACTIVITY_LABELS: Record<TurnActivity, string> = {
  thinking: "Thinking…",
  working: "Working…",
};

// The shared MessageBubble renders `step-start` parts as a dashed "step"
// separator — useful in the run inspector / playground, just noise in this
// simple chat. Drop them before rendering (reference preserved when there are
// none, so memoization still holds for those messages).
function stripStepParts(message: UIMessage): UIMessage {
  if (!message.parts?.some((p) => p.type === "step-start")) return message;
  return { ...message, parts: message.parts.filter((p) => p.type !== "step-start") };
}

// A completed render_view tool part carries a `{ blocks }` view spec the agent
// composed (see the dashboard-agent view catalog). We render those blocks as
// rich cards instead of the generic tool row.
function viewSpecFor(part: UIMessage["parts"][number]): { blocks: unknown[] } | null {
  const p = part as { type: string; output?: { blocks?: unknown[] } };
  if (p.type !== "tool-render_view") return null;
  return Array.isArray(p.output?.blocks) ? { blocks: p.output!.blocks! } : null;
}

// Renders one message. Assistant messages that include a completed render_view
// part get the catalog cards (plus the gather tool rows / lead-in text for
// transparency); everything else uses the shared MessageBubble unchanged, so
// its streaming memoization is preserved for the common case.
const DashboardAgentMessageBubble = memo(function DashboardAgentMessageBubble({
  message,
}: {
  message: UIMessage;
}) {
  if (message.role !== "assistant" || !message.parts?.some((p) => viewSpecFor(p))) {
    return <MessageBubble message={message} />;
  }
  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        const spec = viewSpecFor(part);
        if (spec) return <ViewBlocks key={i} blocks={spec.blocks as never} />;
        return renderPart(part, i);
      })}
    </div>
  );
});

// Renders the conversation with the shared agent message renderer — the same
// MessageBubble the run inspector and playground use, so agent output looks
// identical everywhere — except where the agent emits a view-catalog block,
// which renders as a rich card.
export function DashboardAgentMessages({
  messages,
  activity,
  error,
  onRetry,
  onDismissError,
}: {
  messages: UIMessage[];
  // What the turn is doing right now, or null when nothing is in flight. A turn
  // spends most of its time streaming tool calls, so the indicator has to stay
  // up for the whole turn — not just the initial submit.
  activity: TurnActivity | null;
  error?: Error;
  onRetry?: () => void;
  onDismissError?: () => void;
}) {
  const rootRef = useAutoScrollToBottom([messages, activity]);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div ref={rootRef} className="space-y-4 p-4">
        {messages.map((message) => (
          <DashboardAgentMessageBubble key={message.id} message={stripStepParts(message)} />
        ))}
        {activity && (
          <div className="flex items-center gap-2 text-sm text-text-dimmed">
            <Spinner className="size-3" />
            {ACTIVITY_LABELS[activity]}
          </div>
        )}
        {error && (
          <div className="flex flex-col gap-2 rounded border border-error/30 bg-error/10 px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <span className="text-xs text-error">{error.message}</span>
              {onDismissError && (
                <button
                  type="button"
                  onClick={onDismissError}
                  aria-label="Dismiss error"
                  className="shrink-0 rounded p-0.5 text-text-dimmed transition hover:text-text-bright focus-custom"
                >
                  <XMarkIcon className="size-3.5" />
                </button>
              )}
            </div>
            {onRetry && (
              <div>
                <Button variant="tertiary/small" LeadingIcon={ArrowPathIcon} onClick={onRetry}>
                  Try again
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

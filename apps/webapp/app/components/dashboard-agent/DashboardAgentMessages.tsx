import type { UIMessage } from "@ai-sdk/react";
import { memo } from "react";
import { Spinner } from "~/components/primitives/Spinner";
import { MessageBubble, renderPart } from "~/components/runs/v3/agent/AgentMessageView";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import { ViewBlocks } from "./view-catalog";

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

function hostViewBlocks(part: UIMessage["parts"][number]): unknown[] | null {
  const p = part as { type: string; data?: { blocks?: unknown[] } };
  if (p.type !== "data-view") return null;
  return Array.isArray(p.data?.blocks) ? p.data!.blocks! : null;
}

function investigationBlocksFor(part: UIMessage["parts"][number]): unknown[] | null {
  return viewSpecFor(part)?.blocks ?? hostViewBlocks(part);
}

type InvestigationRef = { id: string; revision: number };

function investigationRef(block: unknown): InvestigationRef | null {
  const b = block as { type?: string; id?: string; revision?: number };
  if (b?.type !== "investigation" || typeof b.id !== "string") return null;
  return { id: b.id, revision: typeof b.revision === "number" ? b.revision : 0 };
}

/** Per investigation id, the one `messageId:partIndex` allowed to render: highest revision. */
export function winningInvestigationOccurrences(messages: UIMessage[]): Map<string, string> {
  const best = new Map<string, { revision: number; occurrence: string }>();
  for (const message of messages) {
    (message.parts ?? []).forEach((part, partIndex) => {
      for (const block of investigationBlocksFor(part) ?? []) {
        const ref = investigationRef(block);
        if (!ref) continue;
        const current = best.get(ref.id);
        if (!current || ref.revision >= current.revision) {
          best.set(ref.id, { revision: ref.revision, occurrence: `${message.id}:${partIndex}` });
        }
      }
    });
  }
  return new Map([...best.entries()].map(([id, w]) => [id, w.occurrence]));
}

function withoutSupersededInvestigations(
  blocks: unknown[],
  occurrence: string,
  winners: Map<string, string> | undefined
): unknown[] {
  if (!winners) return blocks;
  return blocks.filter((block) => {
    const ref = investigationRef(block);
    return !ref || winners.get(ref.id) === occurrence;
  });
}

// Renders one message. Assistant messages that include a completed render_view
// part get the catalog cards (plus the gather tool rows / lead-in text for
// transparency); everything else uses the shared MessageBubble unchanged, so
// its streaming memoization is preserved for the common case.
const DashboardAgentMessageBubble = memo(function DashboardAgentMessageBubble({
  message,
  investigationWinners,
}: {
  message: UIMessage;
  /** See {@link winningInvestigationOccurrences}. */
  investigationWinners?: Map<string, string>;
}) {
  if (message.role !== "assistant" || !message.parts?.some((p) => viewSpecFor(p))) {
    return <MessageBubble message={message} />;
  }
  return (
    <div className="space-y-2">
      {message.parts.map((part, i) => {
        const spec = viewSpecFor(part);
        if (!spec) return renderPart(part, i);
        const blocks = withoutSupersededInvestigations(
          spec.blocks,
          `${message.id}:${i}`,
          investigationWinners
        );
        if (blocks.length === 0) return null;
        return <ViewBlocks key={i} blocks={blocks as never} />;
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
  isThinking,
  error,
}: {
  messages: UIMessage[];
  isThinking: boolean;
  error?: Error;
}) {
  const rootRef = useAutoScrollToBottom([messages, isThinking]);
  const investigationWinners = winningInvestigationOccurrences(messages);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div ref={rootRef} className="space-y-4 p-4">
        {messages.map((message) => (
          <DashboardAgentMessageBubble
            key={message.id}
            message={stripStepParts(message)}
            investigationWinners={investigationWinners}
          />
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

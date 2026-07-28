import type { UIMessage } from "@ai-sdk/react";
import { ArrowPathIcon, BookOpenIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { AgentIntent } from "@internal/dashboard-agent-contracts";
import { memo, Suspense } from "react";
import { StreamdownRenderer } from "~/components/code/StreamdownRenderer";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Spinner } from "~/components/primitives/Spinner";
import { MessageBubble, renderPart, toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";
import { ChatBubble, ToolUseRow } from "~/components/runs/v3/ai/AIChatMessages";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import { reportBlockFromToolPart } from "./report-block-adapter";
import type { ResolvedUri } from "./ReportView";
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

/**
 * The blocks one part contributes, or null when it isn't a card at all.
 *
 * Two sources, one renderer:
 * - `render_view` — blocks the model composed.
 * - `get_report` — a snapshot block the host builds from the tool's own output,
 *   so the card shows the numbers the model was grounded on rather than numbers
 *   it retyped.
 *
 * Both replace the generic tool row: a rendered card already says everything the
 * raw JSON would. A `get_report` part that can't be adapted (still streaming, or
 * an error) returns null and keeps its tool row, so the failure stays visible.
 */
function blocksFor(part: UIMessage["parts"][number]): unknown[] | null {
  const spec = viewSpecFor(part);
  if (spec) return spec.blocks;
  const report = reportBlockFromToolPart(part);
  return report ? [report] : null;
}

/**
 * A one-line progress indicator, to the left of the transcript. The same
 * component backs the turn indicator ("Working…") and the line under an
 * in-flight tool row, so progress always looks the same.
 */
function AgentProgressLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-dimmed">
      <Spinner className="size-3" />
      {children}
    </div>
  );
}

/** Assistant markdown at the dashboard's default text size, always rendered. */
function AgentMarkdown({ text }: { text: string }) {
  return (
    <ChatBubble>
      <div className="streamdown-container min-w-0 font-sans text-sm font-normal text-text-dimmed wrap-anywhere">
        <Suspense fallback={<span className="whitespace-pre-wrap">{text}</span>}>
          <StreamdownRenderer>{text}</StreamdownRenderer>
        </Suspense>
      </div>
    </ChatBubble>
  );
}

// A tool call that hasn't produced output yet. Progress for these goes on its own
// line under the row, not inside it.
const IN_FLIGHT_TOOL_STATES = new Set(["input-streaming", "input-available"]);

/**
 * One assistant part in the chat panel.
 *
 * Everything the panel styles itself is handled here; the rest falls through to
 * the shared `renderPart` so agent output still looks the same across the app.
 * The differences: text is always the rendered markdown (no raw toggle) at the
 * dashboard's default size, a citation is a docs button rather than a bare link,
 * and an in-flight tool row is static with the spinner on a separate line.
 */
function renderDashboardPart(part: UIMessage["parts"][number], i: number) {
  const p = part as {
    type: string;
    text?: string;
    url?: string;
    title?: string;
    state?: string;
    input?: unknown;
    toolCallId?: string;
  };
  const type = part.type as string;

  if (type === "text") {
    return p.text ? <AgentMarkdown key={i} text={p.text} /> : null;
  }

  if (type === "source-url") {
    const safeUrl = toSafeUrl(p.url);
    const label = p.title || p.url;
    if (!safeUrl || !label) return renderPart(part, i);
    return (
      <LinkButton key={i} to={safeUrl} variant="docs/small" LeadingIcon={BookOpenIcon}>
        {label}
      </LinkButton>
    );
  }

  if (type.startsWith("tool-") && IN_FLIGHT_TOOL_STATES.has(p.state ?? "")) {
    const toolName = type.slice(5);
    return (
      <div key={i} className="space-y-2">
        <ToolUseRow
          tool={{
            toolCallId: p.toolCallId ?? `tool-${i}`,
            toolName,
            inputJson: JSON.stringify(p.input ?? {}, null, 2),
          }}
        />
        <AgentProgressLine>Running {toolName}…</AgentProgressLine>
      </div>
    );
  }

  return renderPart(part, i);
}

// Renders one message. User messages use the shared MessageBubble unchanged;
// assistant parts go through the panel's own renderer, and a card-producing part
// (render_view / get_report) becomes a catalog card instead of a tool row.
const DashboardAgentMessageBubble = memo(function DashboardAgentMessageBubble({
  message,
  onIntent,
  resolveUri,
}: {
  message: UIMessage;
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
}) {
  if (message.role !== "assistant") {
    return <MessageBubble message={message} />;
  }
  const parts = message.parts ?? [];
  if (parts.length === 0) return null;
  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        const blocks = blocksFor(part);
        if (blocks) {
          return (
            <ViewBlocks
              key={i}
              blocks={blocks as never}
              onIntent={onIntent}
              resolveUri={resolveUri}
            />
          );
        }
        return renderDashboardPart(part, i);
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
  onIntent,
  resolveUri,
}: {
  messages: UIMessage[];
  // What the turn is doing right now, or null when nothing is in flight. A turn
  // spends most of its time streaming tool calls, so the indicator has to stay
  // up for the whole turn — not just the initial submit.
  activity: TurnActivity | null;
  error?: Error;
  onRetry?: () => void;
  onDismissError?: () => void;
  /** Where a card's actions go. Threaded down to the view catalog. */
  onIntent?: (intent: AgentIntent) => void;
  /** Host resolver for `trigger://` URIs a card cites. */
  resolveUri?: (uri: string) => ResolvedUri | null;
}) {
  const rootRef = useAutoScrollToBottom([messages, activity]);

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <div ref={rootRef} className="space-y-4 p-4">
        {messages.map((message) => (
          <DashboardAgentMessageBubble
            key={message.id}
            message={stripStepParts(message)}
            onIntent={onIntent}
            resolveUri={resolveUri}
          />
        ))}
        {activity && <AgentProgressLine>{ACTIVITY_LABELS[activity]}</AgentProgressLine>}
        {error && (
          <Callout
            variant="error"
            cta={
              (onRetry || onDismissError) && (
                <div className="flex shrink-0 items-center gap-1">
                  {onRetry && (
                    <Button variant="primary/small" LeadingIcon={ArrowPathIcon} onClick={onRetry}>
                      Try again
                    </Button>
                  )}
                  {onDismissError && (
                    <Button
                      variant="minimal/small"
                      LeadingIcon={XMarkIcon}
                      onClick={onDismissError}
                      aria-label="Dismiss error"
                    />
                  )}
                </div>
              )
            }
          >
            {error.message}
          </Callout>
        )}
      </div>
    </div>
  );
}

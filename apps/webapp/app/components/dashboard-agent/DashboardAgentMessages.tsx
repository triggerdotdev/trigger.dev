import type { UIMessage } from "@ai-sdk/react";
import { ArrowPathIcon, BookOpenIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { AgentIntent } from "@internal/dashboard-agent-contracts";
import { memo } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { renderPart, toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";
import { ToolUseRow } from "~/components/runs/v3/ai/AIChatMessages";
import { useAutoScrollToBottom } from "~/hooks/useAutoScrollToBottom";
import {
  ChatActionsRow,
  ChatCardSlot,
  ChatProgress,
  ChatText,
  ChatToolRow,
  ChatTranscript,
  ChatTurn,
} from "./chat-layout";
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

export type DashboardAgentMessagesProps = {
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

// A tool call that hasn't produced output yet. Progress for these goes on its own
// line under the row, not inside it.
const IN_FLIGHT_TOOL_STATES = new Set(["input-streaming", "input-available"]);

// #region chat-layout transcript
// Everything from here down composes via ./chat-layout only — see rule 1 there.
// `chat-layout.test.ts` fails if a spacing utility class appears in this region.

/**
 * One assistant part in the chat panel.
 *
 * Everything the panel styles itself is handled here; the rest falls through to
 * the shared `renderPart` so agent output still looks the same across the app.
 * The differences: text is always the rendered markdown (no raw toggle) at the
 * dashboard's default size, and an in-flight tool row is static with the spinner
 * on a separate line. Citations are handled a level up, where a run of them can
 * be grouped into one row.
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
    return p.text ? <ChatText key={i} text={p.text} /> : null;
  }

  if (type.startsWith("tool-") && IN_FLIGHT_TOOL_STATES.has(p.state ?? "")) {
    const toolName = type.slice(5);
    return (
      <ChatToolRow key={i}>
        <ToolUseRow
          tool={{
            toolCallId: p.toolCallId ?? `tool-${i}`,
            toolName,
            inputJson: JSON.stringify(p.input ?? {}, null, 2),
          }}
        />
        <ChatProgress>Running {toolName}…</ChatProgress>
      </ChatToolRow>
    );
  }

  return renderPart(part, i);
}

/**
 * A citation the panel can render as a docs button: a `source-url` part with a
 * safe URL and something to label it with. Anything else falls through to the
 * shared renderer.
 */
function citationFor(part: UIMessage["parts"][number]): { url: string; label: string } | null {
  const p = part as { type: string; url?: string; title?: string };
  if (p.type !== "source-url") return null;
  const url = toSafeUrl(p.url);
  const label = p.title || p.url;
  return url && label ? { url, label } : null;
}

/** The text of a user message: every text part, joined. */
function userText(message: UIMessage): string {
  return (
    message.parts
      ?.filter((part) => part.type === "text")
      .map((part) => (part as { type: "text"; text: string }).text)
      .join("") ?? ""
  );
}

// Renders one message as one turn. A user turn is the accent bubble; assistant
// parts go through the panel's own renderer, and a card-producing part
// (render_view / get_report) becomes a catalog card instead of a tool row.
const DashboardAgentTurn = memo(function DashboardAgentTurn({
  message,
  onIntent,
  resolveUri,
}: {
  message: UIMessage;
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
}) {
  if (message.role === "user") {
    return (
      <ChatTurn role="user">
        <ChatText role="user" text={userText(message)} />
      </ChatTurn>
    );
  }
  if (message.role !== "assistant") return null;
  const parts = message.parts ?? [];
  if (parts.length === 0) return null;

  const body: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;

    const blocks = blocksFor(part);
    if (blocks) {
      body.push(
        <ChatCardSlot key={i}>
          <ViewBlocks blocks={blocks as never} onIntent={onIntent} resolveUri={resolveUri} />
        </ChatCardSlot>
      );
      continue;
    }

    // Citations arrive one part each, but they read as a list of sources — so a
    // run of consecutive ones becomes one wrapping row of docs buttons rather
    // than a stack of full-width lines. A lone citation is that row with one
    // button in it.
    if (citationFor(part)) {
      const start = i;
      const buttons: React.ReactNode[] = [];
      while (i < parts.length) {
        const citation = citationFor(parts[i]!);
        if (!citation) break;
        buttons.push(
          <LinkButton key={i} to={citation.url} variant="docs/small" LeadingIcon={BookOpenIcon}>
            {citation.label}
          </LinkButton>
        );
        i++;
      }
      i--;
      body.push(<ChatActionsRow key={`citations-${start}`}>{buttons}</ChatActionsRow>);
      continue;
    }

    body.push(renderDashboardPart(part, i));
  }

  return <ChatTurn>{body}</ChatTurn>;
});

/**
 * The turns of a conversation, without the transcript around them — for a host
 * that owns its own `ChatTranscript` and interleaves other content between
 * turns (the demo playbook does exactly this).
 */
export function DashboardAgentTurns({
  messages,
  activity,
  error,
  onRetry,
  onDismissError,
  onIntent,
  resolveUri,
}: DashboardAgentMessagesProps) {
  return (
    <>
      {messages.map((message) => (
        <DashboardAgentTurn
          key={message.id}
          message={stripStepParts(message)}
          onIntent={onIntent}
          resolveUri={resolveUri}
        />
      ))}
      {activity && (
        <ChatTurn>
          <ChatProgress>{ACTIVITY_LABELS[activity]}</ChatProgress>
        </ChatTurn>
      )}
      {error && (
        <ChatTurn>
          <ChatCardSlot>
            <Callout
              variant="error"
              cta={
                (onRetry || onDismissError) && (
                  <ChatActionsRow>
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
                  </ChatActionsRow>
                )
              }
            >
              {error.message}
            </Callout>
          </ChatCardSlot>
        </ChatTurn>
      )}
    </>
  );
}

// The conversation in its own scroll column. Layout — the inset, the rhythm
// between turns, where a card or a progress line sits — is `./chat-layout`'s;
// this component only decides what each part turns into.
export function DashboardAgentMessages(props: DashboardAgentMessagesProps) {
  const rootRef = useAutoScrollToBottom([props.messages, props.activity]);

  return (
    <ChatTranscript contentRef={rootRef}>
      <DashboardAgentTurns {...props} />
    </ChatTranscript>
  );
}
// #endregion chat-layout transcript

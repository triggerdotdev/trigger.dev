import type { UIMessage } from "@ai-sdk/react";
import { ArrowPathIcon, BookOpenIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { AgentIntent } from "@internal/dashboard-agent-contracts";
import { useNavigate } from "@remix-run/react";
import { memo } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { renderPart, toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";
import { sameOriginPath } from "./navigate-target";
import { hasToolProgressLine, IN_FLIGHT_TOOL_STATES } from "./progress-line";
import { useTranscriptAutoScroll } from "./useTranscriptAutoScroll";
import {
  ChatActionsRow,
  ChatCardSlot,
  ChatPendingTool,
  ChatProgress,
  ChatText,
  ChatTranscript,
  ChatTurn,
  ChatWakeSlot,
} from "./chat-layout";
import { toolPendingLabel } from "./tool-labels";
import { reportBlockFromToolPart } from "./report-block-adapter";
import type { ResolvedUri } from "./ReportView";
import { ViewBlocks } from "./view-catalog";
import { findWakeWatch, WakeBanner, wakeRefFromMessageId, type WakeWatch } from "./WakeBanner";

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
  /** Host-resolved dashboard paths for settings-page footer actions. */
  pagePaths?: Record<string, string>;
  /**
   * The chat's watches, when the host has them. A wake message names the watch
   * it came from, so this is what lets its banner say *what* was being watched
   * and colour the outcome by kind. Without it a wake still gets a banner, in
   * kind-agnostic wording.
   */
  watches?: WakeWatch[];
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
 * raw JSON would. A `get_report` part that can't be adapted returns null and
 * falls through — to the pending pill while it is still streaming, to the tool row
 * once it has failed, so the failure stays visible.
 */
function blocksFor(part: UIMessage["parts"][number]): unknown[] | null {
  const spec = viewSpecFor(part);
  if (spec) return spec.blocks;
  const report = reportBlockFromToolPart(part);
  return report ? [report] : null;
}

type InvestigationRef = { id: string; revision: number };

function investigationRef(block: unknown): InvestigationRef | null {
  const b = block as { type?: string; id?: string; revision?: number };
  if (b?.type !== "investigation" || typeof b.id !== "string") return null;
  return { id: b.id, revision: typeof b.revision === "number" ? b.revision : 0 };
}

/**
 * Latest-wins across the WHOLE transcript, not just within one tool call: an
 * investigation renders at least twice (in_progress, then the verdict), each
 * from its own render_view part, so without this the user sees the working
 * copy stacked above the finished card. Returns, per investigation id, the one
 * occurrence (`messageId:partIndex`) allowed to render — the highest revision,
 * last occurrence winning a tie.
 */
export function winningInvestigationOccurrences(messages: UIMessage[]): Map<string, string> {
  const best = new Map<string, { revision: number; occurrence: string }>();
  for (const message of messages) {
    (message.parts ?? []).forEach((part, partIndex) => {
      for (const block of blocksFor(part) ?? []) {
        const ref = investigationRef(block);
        if (!ref) continue;
        const current = best.get(ref.id);
        if (!current || ref.revision >= current.revision) {
          best.set(ref.id, {
            revision: ref.revision,
            occurrence: `${message.id}:${partIndex}`,
          });
        }
      }
    });
  }
  return new Map([...best.entries()].map(([id, w]) => [id, w.occurrence]));
}

/** Drop investigation blocks whose id renders elsewhere (a later revision). */
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

// #region chat-layout transcript
// Everything from here down composes via ./chat-layout only — see rule 1 there.
// `chat-layout.test.ts` fails if a spacing utility class appears in this region.

/**
 * One assistant part in the chat panel.
 *
 * Everything the panel styles itself is handled here; the rest falls through to
 * the shared `renderPart` so agent output still looks the same across the app.
 * The differences: text is always the rendered markdown (no raw toggle) at the
 * dashboard's default size, and tool calls never show their mechanics — while
 * running they are a pending pill ("Reading the queue…"), and once they land
 * they leave NO row at all: the answer is the prose and the cards, not the
 * input/output plumbing. The one exception is a FAILED call, which keeps its
 * error row — a silent failure would read as the agent ignoring the question.
 * Citations are handled a level up, where a run of them can be grouped into one
 * row.
 */
function renderDashboardPart(
  part: UIMessage["parts"][number],
  i: number,
  options?: { suppressPendingPill?: boolean }
) {
  const p = part as {
    type: string;
    text?: string;
    url?: string;
    title?: string;
    state?: string;
  };
  const type = part.type as string;

  if (type === "text") {
    return p.text ? <ChatText key={i} text={p.text} /> : null;
  }

  if (type.startsWith("tool-")) {
    if (IN_FLIGHT_TOOL_STATES.has(p.state ?? "")) {
      // One spinner at a time: an in_progress investigation card in this turn
      // already shows its own progress pill.
      if (options?.suppressPendingPill) return null;
      return <ChatPendingTool key={i} label={`${toolPendingLabel(type.slice(5))}…`} />;
    }
    if (p.state === "output-error") return renderPart(part, i);
    return null;
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

/**
 * One citation, as a button.
 *
 * A citation into our own dashboard is a place in this app, so it navigates in
 * place — as an absolute URL it would otherwise render as an external link and
 * open a second copy of the dashboard in a new tab. Real external links keep
 * their new tab.
 */
function CitationButton({ url, label }: { url: string; label: string }) {
  const navigate = useNavigate();
  const path = typeof window === "undefined" ? null : sameOriginPath(url, window.location.origin);

  if (path) {
    return (
      <Button variant="docs/small" LeadingIcon={BookOpenIcon} onClick={() => navigate(path)}>
        {label}
      </Button>
    );
  }

  return (
    <LinkButton to={url} variant="docs/small" LeadingIcon={BookOpenIcon}>
      {label}
    </LinkButton>
  );
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
// (render_view / get_report) becomes a catalog card instead of a tool row. A
// wake — an assistant turn nobody asked for — keeps the same body under a banner.
const DashboardAgentTurn = memo(function DashboardAgentTurn({
  message,
  onIntent,
  resolveUri,
  pagePaths,
  watches,
  investigationWinners,
}: {
  message: UIMessage;
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
  pagePaths?: Record<string, string>;
  watches?: WakeWatch[];
  /** See {@link winningInvestigationOccurrences}. */
  investigationWinners?: Map<string, string>;
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

  // An in_progress investigation card carries its own live pill (its
  // `progress` line), so a concurrent tool pill would put two spinners on
  // screen — the card's, being the more specific, wins.
  const hasLiveInvestigationCard = parts.some((part, i) =>
    withoutSupersededInvestigations(
      blocksFor(part) ?? [],
      `${message.id}:${i}`,
      investigationWinners
    ).some(
      (block) =>
        (block as { type?: string; outcome?: unknown; investigation?: { outcome?: string } })
          .type === "investigation" &&
        (block as { investigation?: { outcome?: string } }).investigation?.outcome === "in_progress"
    )
  );

  const body: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;

    const rawBlocks = blocksFor(part);
    if (rawBlocks) {
      const blocks = withoutSupersededInvestigations(
        rawBlocks,
        `${message.id}:${i}`,
        investigationWinners
      );
      if (blocks.length > 0) {
        body.push(
          <ChatCardSlot key={i}>
            <ViewBlocks
              blocks={blocks as never}
              onIntent={onIntent}
              resolveUri={resolveUri}
              pagePaths={pagePaths}
            />
          </ChatCardSlot>
        );
      }
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
        buttons.push(<CitationButton key={i} url={citation.url} label={citation.label} />);
        i++;
      }
      i--;
      body.push(<ChatActionsRow key={`citations-${start}`}>{buttons}</ChatActionsRow>);
      continue;
    }

    body.push(renderDashboardPart(part, i, { suppressPendingPill: hasLiveInvestigationCard }));
  }

  // A wake narration is identified by the message id the agent wrote it under,
  // so nothing about the parts has to change: same prose, with a banner above it
  // saying the watch — not the user — started this turn.
  const wake = wakeRefFromMessageId(message.id);
  if (wake) {
    return (
      <ChatTurn>
        <ChatWakeSlot
          banner={
            <WakeBanner outcome={wake.outcome} watch={findWakeWatch(watches, wake.watchId)} />
          }
        >
          {body}
        </ChatWakeSlot>
      </ChatTurn>
    );
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
  pagePaths,
  watches,
}: DashboardAgentMessagesProps) {
  // One status line at a time: a tool's own progress beats the generic activity.
  const showActivity = activity !== null && !hasToolProgressLine(messages);

  // Strip once, up front: the winners map keys occurrences by part index, so
  // it must be computed on the exact parts the turns will render.
  const stripped = messages.map(stripStepParts);

  // Across the whole transcript, one card per investigation: the latest
  // revision renders where it landed; earlier working copies disappear.
  const investigationWinners = winningInvestigationOccurrences(stripped);

  return (
    <>
      {stripped.map((message) => (
        <DashboardAgentTurn
          key={message.id}
          message={message}
          onIntent={onIntent}
          resolveUri={resolveUri}
          pagePaths={pagePaths}
          watches={watches}
          investigationWinners={investigationWinners}
        />
      ))}
      {showActivity && activity && (
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
  const rootRef = useTranscriptAutoScroll(props.messages, props.activity);

  return (
    <ChatTranscript contentRef={rootRef}>
      <DashboardAgentTurns {...props} />
    </ChatTranscript>
  );
}
// #endregion chat-layout transcript

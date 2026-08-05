import type { UIMessage } from "@ai-sdk/react";
import { ArrowPathIcon, BookOpenIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { AgentIntent } from "@internal/dashboard-agent-contracts";
import { useNavigate } from "@remix-run/react";
import { memo } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { renderPart, toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";
import { sameOriginPath } from "./navigate-target";
import { IN_FLIGHT_TOOL_STATES, liveProgress, type TurnActivity } from "./progress-line";
import { useTranscriptAutoScroll } from "./useTranscriptAutoScroll";
import {
  ChatActionsRow,
  ChatCardSlot,
  ChatProgress,
  ChatText,
  ChatTranscript,
  ChatTurn,
  ChatWakeSlot,
} from "./chat-layout";
import { reportBlockFromToolPart } from "./report-block-adapter";
import type { ResolvedUri } from "./ReportView";
import { ViewBlocks } from "./view-catalog";
import { findWakeWatch, WakeBanner, wakeRefFromMessageId, type WakeWatch } from "./WakeBanner";

export type { TurnActivity };

export type DashboardAgentMessagesProps = {
  messages: UIMessage[];
  // What the turn is doing right now, or null when nothing is in flight. Stays
  // up for the whole turn, not just the initial submit.
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
   * The chat's watches, when the host has them. Lets a wake banner name what was
   * being watched. Without it the banner falls back to kind-agnostic wording.
   */
  watches?: WakeWatch[];
};

// `step-start` parts render as a dashed separator in the shared bubble, which is
// noise here. The message reference is preserved when there are none, so
// memoization still holds.
function stripStepParts(message: UIMessage): UIMessage {
  if (!message.parts?.some((p) => p.type === "step-start")) return message;
  return { ...message, parts: message.parts.filter((p) => p.type !== "step-start") };
}

// A completed render_view tool part carries a `{ blocks }` view spec, rendered as
// cards instead of the generic tool row.
function viewSpecFor(part: UIMessage["parts"][number]): { blocks: unknown[] } | null {
  const p = part as { type: string; output?: { blocks?: unknown[] } };
  if (p.type !== "tool-render_view") return null;
  return Array.isArray(p.output?.blocks) ? { blocks: p.output!.blocks! } : null;
}

/**
 * The blocks one part contributes, or null when it isn't a card at all. Sources
 * are `render_view` (blocks the model composed) and `get_report` (a snapshot the
 * host builds from the tool output, so the card shows the numbers the model was
 * grounded on). A `get_report` part that can't be adapted returns null and falls
 * through to the tool row, keeping a failure visible.
 */
function blocksFor(part: UIMessage["parts"][number]): unknown[] | null {
  const spec = viewSpecFor(part);
  if (spec) return spec.blocks;
  const hostBlocks = hostViewBlocks(part);
  if (hostBlocks) return hostBlocks;
  const report = reportBlockFromToolPart(part);
  return report ? [report] : null;
}

/**
 * Blocks the host wrote, with no tool behind them. The watch card's confirmation
 * and one-shot result have no model turn to hang off, so they travel as a plain
 * `data-view` part and render through the same `ViewBlocks` catalog.
 */
function hostViewBlocks(part: UIMessage["parts"][number]): unknown[] | null {
  const p = part as { type: string; data?: { blocks?: unknown[] } };
  if (p.type !== "data-view") return null;
  return Array.isArray(p.data?.blocks) ? p.data!.blocks! : null;
}

type InvestigationRef = { id: string; revision: number };

function investigationRef(block: unknown): InvestigationRef | null {
  const b = block as { type?: string; id?: string; revision?: number };
  if (b?.type !== "investigation" || typeof b.id !== "string") return null;
  return { id: b.id, revision: typeof b.revision === "number" ? b.revision : 0 };
}

/**
 * Latest-wins across the whole transcript: an investigation renders at least
 * twice (in_progress, then the verdict) from separate render_view parts, so
 * without this the working copy stacks above the finished card. Returns, per
 * investigation id, the one occurrence (`messageId:partIndex`) allowed to
 * render — highest revision, last occurrence wins a tie.
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
// Everything below composes via ./chat-layout only. `chat-layout.test.ts` fails
// if a spacing utility class appears in this region.

/**
 * Rewrite `[label](trigger://…)` links in prose to their resolved dashboard
 * paths. Markdown renderers won't link an unknown scheme, so a raw trigger://
 * target renders dead; while the resolver hasn't answered the link degrades to
 * its plain label, never a dead href.
 */
const TRIGGER_MD_LINK = /\[([^\]]+)\]\((trigger:\/\/[^\s)]+)\)/g;
function resolveTriggerLinks(
  text: string,
  resolveUri?: (uri: string) => ResolvedUri | null
): string {
  if (!text.includes("trigger://")) return text;
  return text.replace(TRIGGER_MD_LINK, (whole, label: string, uri: string) => {
    const resolved = resolveUri?.(uri);
    return resolved ? `[${label}](${resolved.url})` : label;
  });
}

function renderDashboardPart(
  part: UIMessage["parts"][number],
  i: number,
  resolveUri?: (uri: string) => ResolvedUri | null
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
    return p.text ? <ChatText key={i} text={resolveTriggerLinks(p.text, resolveUri)} /> : null;
  }

  if (type.startsWith("tool-")) {
    // An in-flight call renders nothing here: the turn has one live progress
    // element at the bottom of the transcript (see `liveProgress`), and a line
    // per part would remount it, restarting the spinner at every phase change.
    // A failed call keeps its error row so the failure stays visible.
    if (IN_FLIGHT_TOOL_STATES.has(p.state ?? "")) return null;
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
 * One citation, as a button. A same-origin citation navigates in place; as an
 * absolute URL it would open a second copy of the dashboard in a new tab. Real
 * external links keep their new tab.
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

    // Citations arrive one part each. A run of consecutive ones becomes one
    // wrapping row of docs buttons rather than a stack of full-width lines.
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

    body.push(renderDashboardPart(part, i, resolveUri));
  }

  // A wake narration is identified by its message id: same body, with a banner
  // saying the watch, not the user, started this turn.
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
 * The turns of a conversation, without the transcript around them, for a host
 * that owns its own `ChatTranscript` and interleaves other content between turns.
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
  // Strip once, up front: the winners map keys occurrences by part index, so
  // it must be computed on the exact parts the turns will render.
  const stripped = messages.map(stripStepParts);

  // The turn's one live progress element, kept as the last child of this
  // fragment so it never remounts as turns and cards arrive above it. Only its
  // label changes, so the spinner animation runs uninterrupted for the turn.
  const progress = liveProgress(stripped, activity);

  // One card per investigation across the transcript: the latest revision renders
  // where it landed, earlier working copies disappear.
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
      {progress && (
        <ChatTurn>
          <ChatProgress>{progress.label}</ChatProgress>
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

// The conversation in its own scroll column. Layout belongs to `./chat-layout`;
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

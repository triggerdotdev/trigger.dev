import type { UIMessage } from "@ai-sdk/react";
import { ArrowPathIcon, BookOpenIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { AgentIntent } from "@internal/dashboard-agent-contracts";
import { useNavigate } from "@remix-run/react";
import { memo, useMemo, useRef } from "react";
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
} from "./chat-layout";
import { reuseWinners } from "./investigation-winners";
import { stripModelImages } from "./model-markdown";
import { reportBlockFromToolPart } from "./report-block-adapter";
import { shouldShowLiveTurnError } from "./turn-error";
import type { ResolvedUri } from "./ReportView";
import { answerContinuesAfter } from "./view-actions";
import { ViewBlocks } from "./view-catalog";

export type { TurnActivity };

export type DashboardAgentMessagesProps = {
  messages: UIMessage[];
  activity: TurnActivity | null;
  error?: Error;
  onRetry?: () => void;
  onDismissError?: () => void;
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
  pagePaths?: Record<string, string>;
};

// Returns the same reference when there are no `step-start` parts, so memoization holds.
function stripStepParts(message: UIMessage): UIMessage {
  if (!message.parts?.some((p) => p.type === "step-start")) return message;
  return { ...message, parts: message.parts.filter((p) => p.type !== "step-start") };
}

function viewSpecFor(part: UIMessage["parts"][number]): { blocks: unknown[] } | null {
  const p = part as { type: string; output?: { blocks?: unknown[] } };
  if (p.type !== "tool-render_view") return null;
  return Array.isArray(p.output?.blocks) ? { blocks: p.output!.blocks! } : null;
}

export function blocksFor(part: UIMessage["parts"][number]): unknown[] | null {
  const spec = viewSpecFor(part);
  if (spec) return spec.blocks;
  const hostBlocks = hostViewBlocks(part);
  if (hostBlocks) return hostBlocks;
  const report = reportBlockFromToolPart(part);
  return report ? [report] : null;
}

function hostViewBlocks(part: UIMessage["parts"][number]): unknown[] | null {
  const p = part as { type: string; data?: { blocks?: unknown[] } };
  if (p.type !== "data-view") return null;
  return Array.isArray(p.data?.blocks) ? p.data!.blocks! : null;
}

// `blocksFor` minus the report branch, which the winner pass would only throw away:
// a report block is always `type: "report"`, so it can never be an investigation.
// Reports are parsed by the turn that renders them, not once per streamed token.
function investigationBlocksFor(part: UIMessage["parts"][number]): unknown[] | null {
  const spec = viewSpecFor(part);
  if (spec) return spec.blocks;
  return hostViewBlocks(part);
}

type InvestigationRef = { id: string; revision: number };

function investigationRef(block: unknown): InvestigationRef | null {
  const b = block as { type?: string; id?: string; revision?: number };
  if (b?.type !== "investigation" || typeof b.id !== "string") return null;
  return { id: b.id, revision: typeof b.revision === "number" ? b.revision : 0 };
}

/**
 * Per investigation id, the one `messageId:partIndex` allowed to render: highest revision.
 * Indexed over the same stripped parts the renderer walks, so the two agree on what part 0 is.
 */
export function winningInvestigationOccurrences(messages: UIMessage[]): Map<string, string> {
  const best = new Map<string, { revision: number; occurrence: string }>();
  for (const message of messages.map(stripStepParts)) {
    (message.parts ?? []).forEach((part, partIndex) => {
      for (const block of investigationBlocksFor(part) ?? []) {
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

// The stable identity is the point: a fresh `Map` re-renders the whole transcript per token.
function useInvestigationWinners(messages: UIMessage[]): Map<string, string> {
  const previous = useRef<Map<string, string>>();
  const next = useMemo(() => winningInvestigationOccurrences(messages), [messages]);
  previous.current = reuseWinners(previous.current, next);
  return previous.current;
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

// #region chat-layout transcript
// `chat-layout.test.ts` fails if a spacing utility class appears in this region.

/** Until the resolver answers, the link degrades to its plain label, never a dead href. */
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
    // Images last: the link resolver's output is model-supplied too.
    return p.text ? (
      <ChatText key={i} text={stripModelImages(resolveTriggerLinks(p.text, resolveUri))} />
    ) : null;
  }

  if (type.startsWith("tool-")) {
    // In-flight calls render nothing here; `liveProgress` owns the turn's progress line.
    if (IN_FLIGHT_TOOL_STATES.has(p.state ?? "")) return null;
    if (p.state === "output-error") return renderPart(part, i);
    return null;
  }

  return renderPart(part, i);
}

function citationFor(part: UIMessage["parts"][number]): { url: string; label: string } | null {
  const p = part as { type: string; url?: string; title?: string };
  if (p.type !== "source-url") return null;
  const url = toSafeUrl(p.url);
  const label = p.title || p.url;
  return url && label ? { url, label } : null;
}

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
  investigationWinners,
}: {
  message: UIMessage;
  onIntent?: (intent: AgentIntent) => void;
  resolveUri?: (uri: string) => ResolvedUri | null;
  pagePaths?: Record<string, string>;
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
              answered={answerContinuesAfter(parts as never, i)}
            />
          </ChatCardSlot>
        );
      }
      continue;
    }

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

  return <ChatTurn>{body}</ChatTurn>;
});

export function DashboardAgentTurns({
  messages,
  activity,
  error,
  onRetry,
  onDismissError,
  onIntent,
  resolveUri,
  pagePaths,
}: DashboardAgentMessagesProps) {
  // Must be the exact parts the turns render: the winners map keys by part index.
  const stripped = useMemo(() => messages.map(stripStepParts), [messages]);

  // Must stay the last child of this fragment; see `progress-line.ts`.
  const progress = liveProgress(stripped, activity);

  const investigationWinners = useInvestigationWinners(stripped);

  const liveError = shouldShowLiveTurnError(error, stripped) ? error : undefined;

  return (
    <>
      {stripped.map((message) => (
        <DashboardAgentTurn
          key={message.id}
          message={message}
          onIntent={onIntent}
          resolveUri={resolveUri}
          pagePaths={pagePaths}
          investigationWinners={investigationWinners}
        />
      ))}
      {progress && (
        <ChatTurn>
          <ChatProgress>{progress.label}</ChatProgress>
        </ChatTurn>
      )}
      {/* Suppressed once the transcript ends in the stored record of this same
          failure, so a reload doesn't show the callout and the record together. */}
      {liveError && (
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
              {liveError.message}
            </Callout>
          </ChatCardSlot>
        </ChatTurn>
      )}
    </>
  );
}

export function DashboardAgentMessages(props: DashboardAgentMessagesProps) {
  const rootRef = useTranscriptAutoScroll(props.messages, props.activity);

  return (
    <ChatTranscript contentRef={rootRef}>
      <DashboardAgentTurns {...props} />
    </ChatTranscript>
  );
}
// #endregion chat-layout transcript

// `id` is the investigationId and `revision` climbs: re-emitting replaces, never stacks.
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import type {
  AgentIntent,
  Evidence,
  HypothesisVerdict,
  InvestigationAction,
  InvestigationBlock,
  InvestigationHypothesis,
  InvestigationSeverity,
  InvestigationTimeline,
  TimelinePhase,
} from "@internal/dashboard-agent-contracts";
import { Fragment, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import {
  CategoryBadge,
  ConfidenceBadge,
  EVIDENCE_ROW_CLASS,
  SeverityBadge,
  VerdictBadge,
} from "./agent-badges";
import { textLinkClassName } from "~/components/primitives/TextLink";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { RunTimelineEvent, type TimelineEventState } from "~/components/run/RunTimeline";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { AgentCard, AgentCardBody, AgentCardHeader } from "./agent-card";
import { AgentText } from "./AgentText";
import { ChatActionsRow } from "./chat-layout";
import type { ResolvedUri } from "./ReportView";
import { withoutWatchActions } from "./view-actions";

const SEVERITY_LABELS: Record<InvestigationSeverity, string> = {
  info: "Info",
  warn: "Degraded",
  crit: "Critical",
};

const VERDICT_LABELS: Record<HypothesisVerdict, string> = {
  testing: "Testing",
  validated: "Validated",
  invalidated: "Ruled out",
};

type ResolveUri = (uri: string) => ResolvedUri | null;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-dimmed">{title}</h4>
      {children}
    </div>
  );
}

function EvidenceItem({
  evidence,
  stacked,
  resolveUri,
}: {
  evidence: Evidence;
  stacked?: boolean;
  resolveUri?: ResolveUri;
}) {
  const resolved = resolveUri?.(evidence.uri) ?? null;
  return (
    <li className={stacked ? "space-y-1.5" : EVIDENCE_ROW_CLASS}>
      {/* The Badge primitive is a grid, so `w-fit` is needed to stop it stretching. */}
      <CategoryBadge className="w-fit justify-self-start">{evidence.kind}</CategoryBadge>
      <div className="min-w-0 space-y-1.5">
        <AgentText
          text={evidence.label}
          className="text-xs text-text-bright"
          resolveUri={resolveUri}
        />
        {resolved ? (
          <a
            href={resolved.url}
            className={cn(textLinkClassName(), "block break-all font-mono text-[10px]")}
          >
            {resolved.label}
          </a>
        ) : (
          <div className="break-all font-mono text-[10px] text-text-dimmed">{evidence.uri}</div>
        )}
        {evidence.excerpt ? (
          <pre className="overflow-x-auto rounded-sm border border-grid-bright bg-background-bright px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
            {evidence.excerpt}
          </pre>
        ) : null}
      </div>
    </li>
  );
}

function HypothesisRow({
  hypothesis,
  resolveUri,
}: {
  hypothesis: InvestigationHypothesis;
  resolveUri?: ResolveUri;
}) {
  return (
    <li className="space-y-3 border-l-2 border-grid-bright pl-4">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={hypothesis.verdict}>
          {VERDICT_LABELS[hypothesis.verdict]}
        </VerdictBadge>
      </div>
      <AgentText
        text={hypothesis.statement}
        className="text-sm text-text-bright"
        resolveUri={resolveUri}
      />
      {hypothesis.finding ? (
        <AgentText
          text={hypothesis.finding}
          className="text-xs text-text-dimmed"
          resolveUri={resolveUri}
        />
      ) : null}
      {hypothesis.evidence.length > 0 ? (
        <ul className="space-y-5 pt-1">
          {hypothesis.evidence.map((evidence, i) => (
            <EvidenceItem key={i} evidence={evidence} stacked resolveUri={resolveUri} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// Hook-free and provider-free on purpose: the card renders as static markup too, and
// the producer's timestamps are shown in UTC rather than read off a clock.
const UTC_DATE = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const UTC_TIME_MS = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
  // @ts-ignore fractionalSecondDigits works in most modern browsers
  fractionalSecondDigits: 3,
});

function shortUtcTime(iso: string): string | undefined {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? undefined : `${UTC_DATE.format(at)} ${UTC_TIME_MS.format(at)} UTC`;
}

// `style: "short"` abbreviates minutes to "m", which reads as metres next to "ms"/"s"/"h" — this
// keeps the long-form words and abbreviates them itself, landing on "min" instead.
function compactDuration(ms: number): string {
  return formatDurationMilliseconds(ms, { maxUnits: 2, maxDecimalPoints: 1 })
    .replaceAll(", ", " ")
    .replace(/ milliseconds?\b/g, " ms")
    .replace(/ seconds?\b/g, " s")
    .replace(/ minutes?\b/g, " min")
    .replace(/ hours?\b/g, " h")
    .replace(/ days?\b/g, " d");
}

// Mirrors RunTimeline's DateTimeAccurate: only the first row (or a day boundary) carries the
// date, later rows are time-only, so the column doesn't repeat "Sep 10" down the whole list.
function phaseTimestamp(at: number, previousAt: number | null): string {
  const sameDay = previousAt !== null && UTC_DATE.format(at) === UTC_DATE.format(previousAt);
  return sameDay ? UTC_TIME_MS.format(at) : `${UTC_DATE.format(at)} ${UTC_TIME_MS.format(at)}`;
}

// Maps the producer's status vocabulary onto the run timeline's colour vocabulary.
function phaseEventState(status: TimelinePhase["status"]): TimelineEventState {
  switch (status) {
    case "error":
      return "error";
    case "ongoing":
      return "inprogress";
    case "done":
      return "complete";
  }
}

// Span labels sometimes repeat their own duration, e.g. "chat turn 1 — 471 s (4 LLM steps)".
// Strips that trailing " — <duration>", leaving any parenthesised remainder for
// `splitTrailingParenthetical` to pull into the info tooltip.
const TRAILING_DURATION = /\s—\s\d+(?:\.\d+)?\s?(?:ms|min|h|m|s)\b(?=\s*\(|$)/;

export function dedupeDurationSuffix(label: string): string {
  return label.replace(TRAILING_DURATION, "");
}

// A trailing "(...)" is extra context, not the title — e.g. "Dequeued (54 ms queue wait)".
// It moves into the info tooltip instead, so the title stays short and scannable.
export function splitTrailingParenthetical(label: string): { display: string; extra?: string } {
  const match = label.match(/\s*\(([^()]*)\)\s*$/);
  if (!match) return { display: label };
  return { display: label.slice(0, match.index).trimEnd(), extra: match[1].trim() };
}

function truncateLabel(label: string, max = 25): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

// Span names come lowercase from user code (e.g. "run"); display-only, so the full
// original label — lowercase and all — stays intact in the `title` attribute.
function capitalizeLabel(label: string): string {
  return /^[a-z]/.test(label) ? label[0].toUpperCase() + label.slice(1) : label;
}

// Mirrors LineMarker's "light" variant colours, kept local so the connector below can
// stretch to fill whatever height its own row needs — RunTimelineLine's is fixed.
function connectorLineClass(state: TimelineEventState): string {
  switch (state) {
    case "error":
      return "bg-error";
    case "inprogress":
      return "bg-pending";
    default:
      return "bg-success";
  }
}

/**
 * A phase-to-phase connector. The gap the label needs lives on this row's own min-height,
 * not on the rows around it, so the vertical line (which stretches to match via flex) has
 * no blank segment to break it — the line is continuous from the first marker to the last.
 */
function TimelineConnector({
  label,
  state,
  instant = false,
  trailing = false,
}: {
  label: React.ReactNode;
  state: TimelineEventState;
  instant?: boolean;
  /** The last connector, under the final (possibly still-ongoing) phase — nothing pulls it
   * toward a next title, so it doesn't need the full inter-phase gap. */
  trailing?: boolean;
}) {
  return (
    <div data-connector className="flex">
      <div className="flex w-[1.125rem] shrink-0 justify-center">
        <div className={cn("relative h-full w-px", connectorLineClass(state))}>
          {state === "inprogress" && (
            <div
              className="absolute inset-0 h-full w-full animate-tile-scroll opacity-50"
              style={{ backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }}
            />
          )}
        </div>
      </div>
      {/* Top-aligned: a tight gap under the title, with the row's min-height pushing the
          roomier gap below the label, down toward the next phase's title. */}
      <div
        className={cn(
          "flex flex-1 items-start pl-1 pt-0.5 text-xs text-text-dimmed",
          instant ? "min-h-4" : trailing ? "min-h-5" : "min-h-9"
        )}
      >
        {label}
      </div>
    </div>
  );
}

function TimelineSection({ timeline }: { timeline: InvestigationTimeline }) {
  if (timeline.phases.length === 0) return null;
  const asOf = shortUtcTime(timeline.asOf);
  const phases = timeline.phases;
  // `startedAt` is producer-set, not schema-validated as a real date — a malformed value must
  // drop the timestamps, not throw out of `Intl.DateTimeFormat.format(NaN)`.
  const startedAtMs = Date.parse(timeline.startedAt);
  const hasStartedAt = !Number.isNaN(startedAtMs);
  return (
    <Section title="Timeline">
      <div className="max-w-full">
        {phases.map((phase, i) => {
          const state = phaseEventState(phase.status);
          const at = hasStartedAt ? startedAtMs + phase.startOffsetMs : null;
          const previousAt =
            hasStartedAt && i > 0 ? startedAtMs + phases[i - 1].startOffsetMs : null;
          const deduped = dedupeDurationSuffix(phase.label);
          const { display, extra } = splitTrailingParenthetical(deduped);
          const tooltipLines = [extra, phase.detail].filter((line): line is string =>
            Boolean(line)
          );
          const isLast = i === phases.length - 1;
          return (
            <Fragment key={i}>
              <div data-state={state}>
                <RunTimelineEvent
                  title={
                    <span className="flex min-w-0 items-center gap-1">
                      <span title={phase.label} className="truncate">
                        {truncateLabel(capitalizeLabel(display))}
                      </span>
                      {tooltipLines.length > 0 ? (
                        <InfoIconTooltip
                          content={
                            <div className="space-y-1">
                              {tooltipLines.map((line, idx) => (
                                <div key={idx}>{line}</div>
                              ))}
                            </div>
                          }
                        />
                      ) : null}
                    </span>
                  }
                  subtitle={
                    at !== null ? (
                      <span className="font-mono tracking-[-0.05rem]">
                        {phaseTimestamp(at, previousAt)}
                      </span>
                    ) : null
                  }
                  state={state}
                  variant="dot-hollow"
                />
              </div>
              {phase.status === "ongoing" ? (
                <TimelineConnector label="ongoing" state="inprogress" trailing={isLast} />
              ) : phase.durationMs !== undefined ? (
                <TimelineConnector
                  label={compactDuration(phase.durationMs)}
                  state={state}
                  trailing={isLast}
                />
              ) : !isLast ? (
                <TimelineConnector label={null} state={state} instant />
              ) : null}
            </Fragment>
          );
        })}
      </div>
      <p className="text-[11px] text-text-faint">
        {compactDuration(timeline.elapsedMs)} elapsed
        {asOf ? `, as of ${asOf}` : null}
        {timeline.truncated ? " · trace truncated, some spans are missing" : null}
      </p>
    </Section>
  );
}

function InvestigationActions({
  actions,
  onIntent,
}: {
  actions: InvestigationAction[];
  onIntent?: (intent: AgentIntent) => void;
}) {
  if (!onIntent || actions.length === 0) return null;
  return (
    <div className="border-t border-grid-bright pt-4">
      <ChatActionsRow>
        {actions.map((action, i) => (
          <Button
            key={i}
            variant={i === 0 ? "primary/small" : "secondary/small"}
            onClick={() => onIntent(action.intent)}
          >
            {action.label}
          </Button>
        ))}
      </ChatActionsRow>
    </div>
  );
}

export function InvestigationCard({
  block,
  defaultExpanded = false,
  resolveUri,
  onIntent,
  answered = false,
  watchEnabled = false,
}: {
  block: InvestigationBlock;
  defaultExpanded?: boolean;
  resolveUri?: ResolveUri;
  onIntent?: (intent: AgentIntent) => void;
  /** The turn kept answering after this card, so "keep digging" has nothing to ask for. */
  answered?: boolean;
  /** Withholds the card's own watch action while watch functionality is behind its flag. */
  watchEnabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const investigation = block.investigation;
  const concluded = investigation.outcome === "concluded";

  const answeredActions = (block.capabilities?.actions ?? []).filter(
    (action) => !answered || action.kind !== "ask_follow_up"
  );
  const cardActions = watchEnabled ? answeredActions : withoutWatchActions(answeredActions);

  return (
    <AgentCard>
      <AgentCardHeader className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-text-dimmed">Investigation</span>
          <SeverityBadge severity={investigation.severity}>
            {SEVERITY_LABELS[investigation.severity]}
          </SeverityBadge>
          <ConfidenceBadge confidence={investigation.confidence} />
        </div>
        {investigation.runId ? (
          <div className="truncate font-mono text-xs text-text-dimmed">{investigation.runId}</div>
        ) : null}
      </AgentCardHeader>

      <AgentCardBody density="roomy">
        <AgentText
          text={investigation.title}
          className="text-sm font-medium text-text-bright"
          resolveUri={resolveUri}
        />

        <Section title={concluded ? "What happened" : "What we know"}>
          <AgentText
            text={investigation.headline}
            className="text-sm text-text-dimmed"
            resolveUri={resolveUri}
          />
        </Section>

        {/* Always visible: for a run still executing this is the answer, not workings. */}
        {investigation.timeline ? <TimelineSection timeline={investigation.timeline} /> : null}

        {/* The schema makes `remediation` and `checkNext` mutually exclusive. */}
        {concluded && investigation.remediation ? (
          <Section title="How to fix">
            <AgentText
              text={investigation.remediation}
              className="text-sm text-text-dimmed"
              resolveUri={resolveUri}
            />
          </Section>
        ) : null}

        {investigation.checkNext && investigation.checkNext.length > 0 ? (
          <Section title="What to check next">
            <ol className="list-decimal space-y-2 pl-5">
              {investigation.checkNext.map((item, i) => (
                <li key={i}>
                  <AgentText
                    text={item}
                    className="text-sm text-text-dimmed"
                    resolveUri={resolveUri}
                  />
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        {investigation.caveat ? (
          <Callout variant="warning">{investigation.caveat.message}</Callout>
        ) : null}

        <div className="space-y-4 border-t border-grid-bright pt-4">
          <Button
            variant="minimal/small"
            onClick={() => setExpanded((v) => !v)}
            LeadingIcon={expanded ? ChevronDownIcon : ChevronRightIcon}
            aria-expanded={expanded}
          >
            <span className="flex items-center gap-1.5 text-xs text-text-dimmed">
              {expanded ? "Hide how I worked this out" : "How I worked this out"}
              <span className="text-text-faint">
                ({investigation.hypotheses.length} hypothes
                {investigation.hypotheses.length === 1 ? "is" : "es"})
              </span>
            </span>
          </Button>

          {expanded ? (
            <div className="space-y-5 pt-1">
              {investigation.hypotheses.length > 0 ? (
                <Section title="Hypotheses">
                  <ul className="space-y-5">
                    {investigation.hypotheses.map((hypothesis) => (
                      <HypothesisRow
                        key={hypothesis.id}
                        hypothesis={hypothesis}
                        resolveUri={resolveUri}
                      />
                    ))}
                  </ul>
                </Section>
              ) : null}

              {investigation.evidence.length > 0 ? (
                <Section title="Evidence">
                  <ul className="space-y-3">
                    {investigation.evidence.map((evidence, i) => (
                      <EvidenceItem key={i} evidence={evidence} resolveUri={resolveUri} />
                    ))}
                  </ul>
                </Section>
              ) : null}
            </div>
          ) : null}
        </div>

        <InvestigationActions actions={cardActions} onIntent={onIntent} />
      </AgentCardBody>
    </AgentCard>
  );
}

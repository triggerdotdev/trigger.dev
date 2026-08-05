/**
 * The panel's rendering of an `investigation` view block.
 *
 * The card shows no spinner of its own. The transcript has exactly one live
 * progress element for the whole turn (see `progress-line.ts`), and a spinner
 * here would restart its animation on every revision of the card.
 *
 * An investigation is the one progressive block: its `id` is the investigationId
 * and its `revision` climbs, so re-emitting it replaces this card instead of
 * stacking a second one (see `view-blocks.ts`).
 *
 * Pure component: props in, markup out, no Remix hooks or router context, so it
 * renders in the panel and the gallery from the same fixture. `trigger://`
 * evidence URIs are resolved by the host through `resolveUri`; without a
 * resolver the raw URI is shown.
 */
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import type {
  AgentIntent,
  Evidence,
  HypothesisVerdict,
  InvestigationAction,
  InvestigationBlock,
  InvestigationHypothesis,
  InvestigationSeverity,
} from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import {
  CategoryBadge,
  ConfidenceBadge,
  EVIDENCE_ROW_CLASS,
  SeverityBadge,
  VerdictBadge,
} from "./agent-badges";
import { ChatActionsRow } from "./chat-layout";
import type { ResolvedUri } from "./ReportView";

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

/** One citation: its kind, its label, the resource it points at, and a snippet. */
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
      {/* `w-fit` keeps the badge its own size in the stacked item: the Badge
          primitive is a grid and would otherwise stretch to full width. */}
      <CategoryBadge className="w-fit justify-self-start">{evidence.kind}</CategoryBadge>
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs text-text-bright">{evidence.label}</p>
        {resolved ? (
          <a
            href={resolved.url}
            // The app's link token (theme-remapped), as the report card uses.
            className="block break-all font-mono text-[10px] text-text-link transition hover:underline"
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
      <p className="text-sm text-text-bright">{hypothesis.statement}</p>
      {hypothesis.finding ? <p className="text-xs text-text-dimmed">{hypothesis.finding}</p> : null}
      {hypothesis.evidence.length > 0 ? (
        // Stacked, not two-column: nested under the hypothesis indent the content
        // column would be too narrow for identifiers and excerpts. The wide gap is
        // the only thing separating one citation from the next.
        <ul className="space-y-5 pt-1">
          {hypothesis.evidence.map((evidence, i) => (
            <EvidenceItem key={i} evidence={evidence} stacked resolveUri={resolveUri} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The card's footer actions. Every action is server-decided: the executor only
 * attaches one when what it offers exists, so there is nothing to validate here.
 * The card hands the intent to the host and renders nothing without one.
 */
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
            key={action.kind}
            // The first action is the one to take; the rest are alternatives.
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
  /** Start expanded: used by the gallery states that review the detail view. */
  defaultExpanded = false,
  resolveUri,
  /**
   * Where the footer actions go. The card never navigates or asks on its own: it
   * emits an intent and the host honours it. Without it the row isn't rendered.
   */
  onIntent,
}: {
  block: InvestigationBlock;
  defaultExpanded?: boolean;
  resolveUri?: ResolveUri;
  onIntent?: (intent: AgentIntent) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const investigation = block.investigation;
  const concluded = investigation.outcome === "concluded";

  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      <div className="space-y-1.5 border-b border-grid-bright bg-background-bright px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-text-dimmed">Investigation</span>
          <SeverityBadge severity={investigation.severity}>
            {SEVERITY_LABELS[investigation.severity]}
          </SeverityBadge>
          <ConfidenceBadge confidence={investigation.confidence} />
        </div>
        {/* Its own truncating line: a run id doesn't fit the badge row's right
              corner at panel width (same rule as RunDiagnosisCard). */}
        {investigation.runId ? (
          <div className="truncate font-mono text-xs text-text-dimmed">{investigation.runId}</div>
        ) : null}
      </div>

      <div className="space-y-5 px-4 py-4">
        <p className="text-sm font-medium text-text-bright">{investigation.title}</p>

        <Section title={concluded ? "What happened" : "What we know"}>
          <p className="text-sm text-text-dimmed">{investigation.headline}</p>
        </Section>

        {/* A fix is only shown for a concluded investigation; the schema enforces
            the exclusivity with "What to check next". */}
        {concluded && investigation.remediation ? (
          <Section title="How to fix">
            <p className="text-sm text-text-dimmed">{investigation.remediation}</p>
          </Section>
        ) : null}

        {investigation.checkNext && investigation.checkNext.length > 0 ? (
          <Section title="What to check next">
            <ol className="list-decimal space-y-2 pl-5">
              {investigation.checkNext.map((item, i) => (
                <li key={i} className="text-sm text-text-dimmed">
                  {item}
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

        <InvestigationActions actions={block.capabilities?.actions ?? []} onIntent={onIntent} />
      </div>
    </div>
  );
}

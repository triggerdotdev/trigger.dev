// `id` is the investigationId and `revision` climbs: re-emitting replaces, never stacks.
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
import { textLinkClassName } from "~/components/primitives/TextLink";
import { cn } from "~/utils/cn";
import { AgentCard, AgentCardBody, AgentCardHeader } from "./agent-card";
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
        <p className="text-xs text-text-bright">{evidence.label}</p>
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
      <p className="text-sm text-text-bright">{hypothesis.statement}</p>
      {hypothesis.finding ? <p className="text-xs text-text-dimmed">{hypothesis.finding}</p> : null}
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
}: {
  block: InvestigationBlock;
  defaultExpanded?: boolean;
  resolveUri?: ResolveUri;
  onIntent?: (intent: AgentIntent) => void;
  /** The turn kept answering after this card, so "keep digging" has nothing to ask for. */
  answered?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const investigation = block.investigation;
  const concluded = investigation.outcome === "concluded";

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
        <p className="text-sm font-medium text-text-bright">{investigation.title}</p>

        <Section title={concluded ? "What happened" : "What we know"}>
          <p className="text-sm text-text-dimmed">{investigation.headline}</p>
        </Section>

        {/* The schema makes `remediation` and `checkNext` mutually exclusive. */}
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
              {investigation.hypotheses.length > 0 ? (
                <span className="text-text-faint">
                  ({investigation.hypotheses.length} hypothes
                  {investigation.hypotheses.length === 1 ? "is" : "es"})
                </span>
              ) : null}
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

        <InvestigationActions
          actions={(block.capabilities?.actions ?? []).filter(
            (action) => !answered || action.kind !== "ask_follow_up"
          )}
          onIntent={onIntent}
        />
      </AgentCardBody>
    </AgentCard>
  );
}

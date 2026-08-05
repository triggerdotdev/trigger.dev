import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import type { Evidence } from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { ChatProgress } from "../../chat-layout";
import {
  CategoryBadge,
  ConfidenceBadge,
  EVIDENCE_ROW_CLASS,
  SeverityBadge,
  VerdictBadge,
} from "../../agent-badges";
import type {
  DemoHypothesis,
  DemoHypothesisVerdict,
  DemoInvestigation,
  DemoInvestigationSeverity,
} from "../fixtures/investigation";

const SEVERITY_LABELS: Record<DemoInvestigationSeverity, string> = {
  info: "Info",
  warn: "Degraded",
  crit: "Critical",
};

const VERDICT_LABELS: Record<DemoHypothesisVerdict, string> = {
  testing: "Testing",
  validated: "Validated",
  invalidated: "Ruled out",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-dimmed">{title}</h4>
      {children}
    </div>
  );
}

function EvidenceItem({ evidence, stacked }: { evidence: Evidence; stacked?: boolean }) {
  return (
    <li className={stacked ? "space-y-1.5" : EVIDENCE_ROW_CLASS}>
      {/* `w-fit` keeps the badge its own size in the stacked layout: the Badge
          primitive is a grid, so it would otherwise stretch to full width. */}
      <CategoryBadge className="w-fit justify-self-start">{evidence.kind}</CategoryBadge>
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs text-text-bright">{evidence.label}</p>
        <div className="break-all font-mono text-[10px] text-text-dimmed">{evidence.uri}</div>
        {evidence.excerpt ? (
          <pre className="overflow-x-auto rounded-sm border border-grid-bright bg-background-bright px-2 py-1.5 font-mono text-[11px] leading-relaxed text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
            {evidence.excerpt}
          </pre>
        ) : null}
      </div>
    </li>
  );
}

function HypothesisRow({ hypothesis }: { hypothesis: DemoHypothesis }) {
  return (
    <li className="space-y-3 border-l-2 border-grid-bright pl-4">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={hypothesis.verdict}>
          {VERDICT_LABELS[hypothesis.verdict]}
        </VerdictBadge>
        {hypothesis.verdict === "testing" ? <AgentSpinner size={12} /> : null}
      </div>
      <p className="text-sm text-text-bright">{hypothesis.statement}</p>
      {hypothesis.finding ? <p className="text-xs text-text-dimmed">{hypothesis.finding}</p> : null}
      {hypothesis.evidence.length > 0 ? (
        <ul className="space-y-5 pt-1">
          {hypothesis.evidence.map((evidence, i) => (
            <EvidenceItem key={i} evidence={evidence} stacked />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function DemoInvestigationCard({
  investigation,
  defaultExpanded = false,
}: {
  investigation: DemoInvestigation;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const inProgress = investigation.outcome === "in_progress";
  const concluded = investigation.outcome === "concluded";

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
        <div className="space-y-1.5 border-b border-grid-bright bg-background-bright px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-text-dimmed">Investigation</span>
            <SeverityBadge severity={investigation.severity}>
              {SEVERITY_LABELS[investigation.severity]}
            </SeverityBadge>
            <ConfidenceBadge confidence={investigation.confidence} />
          </div>
          {/* Its own truncating line: at panel width the badge row's right corner
              can't hold a run id. Same rule as RunDiagnosisCard. */}
          {investigation.runId ? (
            <div className="truncate font-mono text-xs text-text-dimmed">{investigation.runId}</div>
          ) : null}
        </div>

        <div className="space-y-5 px-4 py-4">
          <p className="text-sm font-medium text-text-bright">{investigation.title}</p>

          <Section title={concluded ? "What happened" : "What we know"}>
            <p className="text-sm text-text-dimmed">{investigation.headline}</p>
          </Section>

          {/* A fix is only shown for a concluded investigation. An inconclusive one
            gets "What to check next" instead, never both. */}
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
                      <HypothesisRow key={hypothesis.id} hypothesis={hypothesis} />
                    ))}
                  </ul>
                </Section>

                {investigation.evidence.length > 0 ? (
                  <Section title="Evidence">
                    <ul className="space-y-3">
                      {investigation.evidence.map((evidence, i) => (
                        <EvidenceItem key={i} evidence={evidence} />
                      ))}
                    </ul>
                  </Section>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {/* Progress sits outside the card, on the same line the chat uses for
        "Working…" and in-flight tools. `ChatProgress` carries the transcript's
        alignment itself, so it lines up with the card rather than its border. */}
      {inProgress ? <ChatProgress>{investigation.progress ?? "Working…"}</ChatProgress> : null}
    </div>
  );
}

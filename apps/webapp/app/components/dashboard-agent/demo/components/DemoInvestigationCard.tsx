/**
 * The investigation card — DEMO ONLY, and deliberately so.
 *
 * There is no `investigation` block in the view catalog yet (M5 owns it), so
 * this renders the proposed payload from `../fixtures/investigation` instead of
 * a validated block. It borrows `RunDiagnosisCard`'s anatomy on purpose —
 * bordered card, header strip with badges, `Section` bodies, the same colour
 * ramp — so a reviewer is judging the *content model* (collapsed verdict,
 * expandable hypotheses, cited evidence) and not a new visual language.
 *
 * When M5 ships, this component's props are the payload contract: whatever the
 * review here approves is what the block should carry.
 */
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import type { Evidence } from "@internal/dashboard-agent-contracts";
import { useState } from "react";
import { Badge } from "~/components/primitives/Badge";
import { Spinner } from "~/components/primitives/Spinner";
import { cn } from "~/utils/cn";
import type {
  DemoHypothesis,
  DemoHypothesisVerdict,
  DemoInvestigation,
  DemoInvestigationSeverity,
} from "../fixtures/investigation";

const SEVERITY_STYLES: Record<DemoInvestigationSeverity, string> = {
  info: "border-border-bright text-text-dimmed",
  warn: "border-amber-500/40 text-amber-400",
  crit: "border-rose-500/40 text-rose-400",
};

const SEVERITY_LABELS: Record<DemoInvestigationSeverity, string> = {
  info: "Info",
  warn: "Degraded",
  crit: "Critical",
};

const CONFIDENCE_STYLES: Record<DemoInvestigation["confidence"], string> = {
  high: "border-emerald-500/40 text-emerald-400",
  medium: "border-amber-500/40 text-amber-400",
  low: "border-border-bright text-text-dimmed",
};

const VERDICT_STYLES: Record<DemoHypothesisVerdict, string> = {
  testing: "border-border-bright text-text-dimmed",
  validated: "border-emerald-500/40 text-emerald-400",
  invalidated: "border-border-bright text-text-dimmed line-through decoration-text-dimmed/60",
};

const VERDICT_LABELS: Record<DemoHypothesisVerdict, string> = {
  testing: "Testing",
  validated: "Validated",
  invalidated: "Ruled out",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium uppercase tracking-wide text-text-dimmed">{title}</h4>
      {children}
    </div>
  );
}

/**
 * One citation. The `trigger://` URI is shown verbatim as monospace text rather
 * than a link: in the real card the host resolves it to a dashboard path, and
 * showing the raw URI here is what lets the reviewer check that the agent cited
 * something addressable at all.
 */
function EvidenceItem({ evidence }: { evidence: Evidence }) {
  return (
    <li className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-1.5 text-xs">
        <span className="rounded-sm bg-background-raised px-1 py-0.5 text-[10px] uppercase tracking-wide text-text-dimmed">
          {evidence.kind}
        </span>
        <span className="text-text-bright">{evidence.label}</span>
      </div>
      <div className="break-all font-mono text-[10px] text-text-dimmed">{evidence.uri}</div>
      {evidence.excerpt ? (
        <pre className="overflow-x-auto rounded-sm border border-grid-bright bg-background-bright px-2 py-1 font-mono text-[11px] leading-relaxed text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          {evidence.excerpt}
        </pre>
      ) : null}
    </li>
  );
}

function HypothesisRow({ hypothesis }: { hypothesis: DemoHypothesis }) {
  return (
    <li className="space-y-1.5 border-l-2 border-grid-bright pl-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="small" className={cn("uppercase", VERDICT_STYLES[hypothesis.verdict])}>
          {VERDICT_LABELS[hypothesis.verdict]}
        </Badge>
        {hypothesis.verdict === "testing" ? <Spinner className="size-3" /> : null}
      </div>
      <p className="text-sm text-text-bright">{hypothesis.statement}</p>
      {hypothesis.finding ? <p className="text-xs text-text-dimmed">{hypothesis.finding}</p> : null}
      {hypothesis.evidence.length > 0 ? (
        <ul className="space-y-2 pt-0.5">
          {hypothesis.evidence.map((evidence, i) => (
            <EvidenceItem key={i} evidence={evidence} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function DemoInvestigationCard({
  investigation,
  /** Start expanded — used by the playbook case that reviews the detail view. */
  defaultExpanded = false,
}: {
  investigation: DemoInvestigation;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const inProgress = investigation.outcome === "in_progress";
  const concluded = investigation.outcome === "concluded";

  return (
    <div className="overflow-hidden rounded-lg border border-border-bright bg-background-dimmed">
      <div className="flex flex-wrap items-center gap-2 border-b border-grid-bright bg-background-bright px-3 py-2">
        <span className="text-xs font-medium text-text-dimmed">Investigation</span>
        <Badge variant="small" className={SEVERITY_STYLES[investigation.severity]}>
          {SEVERITY_LABELS[investigation.severity]}
        </Badge>
        <Badge
          variant="small"
          className={cn("uppercase", CONFIDENCE_STYLES[investigation.confidence])}
        >
          {investigation.confidence} confidence
        </Badge>
        {inProgress ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-text-dimmed">
            <Spinner className="size-3" />
            {investigation.progress ?? "Working"}
          </span>
        ) : investigation.runId ? (
          <span className="ml-auto font-mono text-xs text-text-dimmed">{investigation.runId}</span>
        ) : null}
      </div>

      <div className="space-y-3 px-3 py-3">
        <p className="text-sm font-medium text-text-bright">{investigation.title}</p>

        <Section title={concluded ? "What happened" : "What we know"}>
          <p className="text-sm text-text-dimmed">{investigation.headline}</p>
        </Section>

        {/* A fix is only ever shown for a concluded investigation. An
            inconclusive one gets "What to check next" instead — never both. */}
        {concluded && investigation.remediation ? (
          <Section title="How to fix">
            <p className="text-sm text-text-dimmed">{investigation.remediation}</p>
          </Section>
        ) : null}

        {investigation.checkNext && investigation.checkNext.length > 0 ? (
          <Section title="What to check next">
            <ol className="list-decimal space-y-1 pl-4">
              {investigation.checkNext.map((item, i) => (
                <li key={i} className="text-sm text-text-dimmed">
                  {item}
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        {investigation.caveat ? (
          <div className="rounded-sm border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
            <p className="text-xs text-amber-200/80">{investigation.caveat.message}</p>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-grid-bright pt-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-text-dimmed transition-colors hover:text-text-bright"
          >
            {expanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
            {expanded ? "Hide how I worked this out" : "How I worked this out"}
            <span className="text-text-faint">
              ({investigation.hypotheses.length} hypothes
              {investigation.hypotheses.length === 1 ? "is" : "es"})
            </span>
          </button>

          {expanded ? (
            <div className="space-y-3 pt-1">
              <Section title="Hypotheses">
                <ul className="space-y-3">
                  {investigation.hypotheses.map((hypothesis) => (
                    <HypothesisRow key={hypothesis.id} hypothesis={hypothesis} />
                  ))}
                </ul>
              </Section>

              {investigation.evidence.length > 0 ? (
                <Section title="Evidence">
                  <ul className="space-y-2">
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
  );
}

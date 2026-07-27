/**
 * The `health` report — ORCHESTRATOR + public entry. Two layers:
 *   `assessHealth()`      data -> HealthAssessment (all health reasoning)
 *   `toReportViewModel()` HealthAssessment -> generic ReportViewModel (pure packaging)
 * `interpret()` is the thin composition of the two.
 *
 * The reasoning is split into three independent analyzers, each returning a Finding:
 *   flow.ts · execution.ts · liveness.ts   (foundation in health-core.ts)
 * This module only wires them: build metrics -> run the three -> flow policy -> stale guard
 * -> reads -> summary/footer. PURE — no IO/clock/LLM/formatting.
 */

import {
  isOk,
  maxSeverity,
  type Finding,
  type FooterEntry,
  type Metric,
  type ReportViewModel,
  type Severity,
  type SummaryStatement,
} from "../report-view-model";
import { buildMetrics, computeDrain, HEALTH_THRESHOLDS, type HealthInput } from "./health-core";
import { buildExecutionRead, interpretExecution } from "./execution";
import { applyFlowPolicy, buildFlowRead, interpretFlow } from "./flow";
import { interpretLiveness } from "./liveness";
// Registers the "health" message catalog (side effect) so the renderer resolves this report's
// codes. Kept here — the health report's entry module — so loading it always registers its prose.
import "./health-messages";

// Re-exported so the data layer + tests keep a single import path (`./health`).
export { HEALTH_THRESHOLDS, isPendingIncreasing, type HealthInput } from "./health-core";

// ---------------------------------------------------------------------------
// Stale-telemetry trust guard. When telemetry is genuinely stale, both flow and execution are
// CH-derived and untrustworthy: mark them unknown and strip everything that would advise action
// off stale data (recommendation, attribution, exclusions, observations, hedge, anomaly window).
// ---------------------------------------------------------------------------

function applyStaleGuard(
  flow: Finding,
  execution: Finding,
  telemetryStale: boolean
): { flow: Finding; execution: Finding; treatedCrit: boolean } {
  if (!telemetryStale) return { flow, execution, treatedCrit: false };
  // Force crit so severity is consistent across summary / section glyph / JSON, and strip the
  // ACTIONABLE causal fields so no surface advises off stale data. Raw metrics/evidence stay in
  // the VM for diagnostics, flagged informational-only by `facts.trustworthy: false`.
  const untrust = (f: Finding): Finding => ({
    ...f,
    severity: "crit",
    reason: "unknown",
    recommendation: undefined,
    attribution: undefined,
    exclusions: undefined,
    observations: undefined,
    hedge: undefined,
    anomalyWindow: undefined,
  });
  return { flow: untrust(flow), execution: untrust(execution), treatedCrit: true };
}

// ---------------------------------------------------------------------------
// Summary.
// ---------------------------------------------------------------------------

function aggregateSummary(
  flow: Finding,
  execution: Finding,
  liveness: Finding,
  executionTreatedCrit: boolean
): { severity: Severity; statements: SummaryStatement[] } {
  const executionSummarySeverity: Severity = executionTreatedCrit ? "crit" : execution.severity;
  const severity = maxSeverity(flow.severity, executionSummarySeverity, liveness.severity);
  const statements: SummaryStatement[] = [
    {
      findingType: "flow",
      severity: flow.severity,
      reason: flow.reason === "unknown" ? "unknown" : undefined,
    },
    {
      findingType: "execution",
      severity: executionSummarySeverity,
      reason: execution.reason === "unknown" ? "unknown" : undefined,
    },
    {
      findingType: "liveness",
      severity: liveness.severity,
      reason: liveness.reason === "freshness_unknown" ? "freshness_unknown" : undefined,
    },
  ];
  return { severity, statements };
}

// ---------------------------------------------------------------------------
// Footer (dominant action + do-nothing option) + links.
// ---------------------------------------------------------------------------

const SEV_RANK: Record<Severity, number> = { ok: 0, warn: 1, crit: 2 };

function dominantFinding(findings: Finding[]): Finding | undefined {
  let best: Finding | undefined;
  for (const f of findings) {
    if (!f.recommendation) continue;
    if (!best || SEV_RANK[f.severity] > SEV_RANK[best.severity]) best = f;
  }
  return best;
}

function buildFooter(
  findings: Finding[],
  drain: { drainMinutes: number; isDrainable: boolean },
  telemetryStale: boolean
): FooterEntry[] {
  // Stale telemetry: the only trustworthy action is to check the pipeline itself.
  if (telemetryStale) {
    const liveness = findings.find((f) => f.type === "liveness");
    return liveness?.recommendation
      ? [{ code: liveness.recommendation.code, link: liveness.recommendation.link }]
      : [{ code: "nothing_to_do" }];
  }

  const dominant = dominantFinding(findings);
  if (!dominant?.recommendation) return [{ code: "nothing_to_do" }];

  const footer: FooterEntry[] = [
    { code: dominant.recommendation.code, link: dominant.recommendation.link },
  ];

  // Second entry: do-nothing when the backlog drains, or the region-move hedge for a
  // dequeue stall (the one place it stays plausible).
  if (dominant.type === "flow") {
    if (drain.isDrainable && Number.isFinite(drain.drainMinutes)) {
      footer.push({ code: "do_nothing_drains", value: Math.round(drain.drainMinutes * 10) / 10 });
    } else if (dominant.reason === "dequeue_stall") {
      footer.push({ code: "region_failover" });
    }
  }
  return footer;
}

function collectLinks(findings: Finding[]): ReportViewModel["links"] {
  const keys = new Set<string>();
  for (const finding of findings) {
    if (finding.recommendation?.link) keys.add(finding.recommendation.link);
    if (finding.hedge?.link) keys.add(finding.hedge.link);
  }
  return [...keys].map((key) => ({ key, label: key, url: "" }));
}

// ---------------------------------------------------------------------------
// Domain layer: HealthAssessment — the health verdict (flow / execution / liveness findings,
// their causes + recommendations, and the derived state). All health semantics live here; it
// knows nothing about how a report is presented. `toReportViewModel` maps it into the generic,
// report-agnostic ReportViewModel — so the VM stays reusable for future reports (each has its
// own <domain>Assessment + mapper; the renderer/VM primitives are shared).
// ---------------------------------------------------------------------------

export type HealthAssessment = {
  /** header, carried through from the input. */
  scope: string;
  period: string;
  baselineLabel: string;
  generatedAt: string;
  windowMinutes: number;
  /** finalized findings (post-policy, post-stale-guard, with reads built). */
  flow: Finding;
  execution: Finding;
  liveness: Finding;
  metrics: Metric[];
  /** derived domain state the presentation layer needs (footer / summary / trust). */
  drain: { drainMinutes: number; isDrainable: boolean };
  telemetryStale: boolean;
  executionTreatedCrit: boolean;
  /** structured payload for agents (already carries the trust marker). */
  facts: Record<string, unknown>;
};

/** Data -> domain verdict. Pure: no IO/clock/LLM/formatting — just health reasoning. */
export function assessHealth(input: HealthInput): HealthAssessment {
  const metrics = buildMetrics(input);
  const drain = computeDrain(input);

  let flow = interpretFlow(metrics, input);
  const executionRaw = interpretExecution(metrics, input);
  const liveness = interpretLiveness(metrics, input);

  // Telemetry freshness as an explicit state so "unknown" (no signal) is never conflated with
  // "lagging" (a real severity). Only GENUINE staleness trust-guards the CH-derived verdicts.
  const ageMs = input.liveness.telemetryAgeMs;
  const telemetryStale = ageMs !== null && ageMs > HEALTH_THRESHOLDS.liveness.staleMs;

  flow = applyFlowPolicy(flow, executionRaw, drain.isDrainable, telemetryStale);

  // Stale telemetry: flow AND execution are untrustworthy -> mark both unknown and strip their
  // actions/attribution/exclusions so nothing advises off stale data.
  const guarded = applyStaleGuard(flow, executionRaw, telemetryStale);
  flow = guarded.flow;
  const execution = guarded.execution;

  // interpretFlow mutates the shared metrics array (e.g. sets concurrency.annotation "pinned 40
  // of last 60 min") BEFORE the guard runs. The renderers hide it for an unknown finding, but
  // format=json would still leak that stale-derived narrative — so strip metric annotations too
  // (the twin of the stripped anomaly window). Raw values stay, flagged by facts.trustworthy.
  if (telemetryStale) {
    for (const m of metrics) m.annotation = undefined;
  }

  // Reads built last, from the finalized findings.
  flow.read = buildFlowRead(flow, isOk(execution.severity), !telemetryStale);
  execution.read = buildExecutionRead(execution, flow);

  return {
    scope: input.scope,
    period: input.period,
    baselineLabel: input.baselineLabel,
    generatedAt: input.generatedAt,
    windowMinutes: input.windowMinutes,
    flow,
    execution,
    liveness,
    metrics,
    drain,
    telemetryStale,
    executionTreatedCrit: guarded.treatedCrit,
    facts: {
      // Trust marker for structured consumers. The metrics/evidence stay (useful for pipeline
      // diagnostics), but when telemetry is stale they're informational-only: an agent must not
      // act on them (e.g. raise concurrency off a stale backlog). The human renderer is already
      // guarded via the "unknown" finding; this is the same guarantee for JSON.
      trustworthy: !telemetryStale,
      staleReason: telemetryStale ? "telemetry_stale" : undefined,
      flowSource: input.flowSource,
      pendingEstimated: input.pending.estimated,
      throughput: input.throughput,
      flowEvidence: input.flowEvidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Presentation mapping: HealthAssessment -> generic ReportViewModel. Pure packaging only —
// no health reasoning here (summary/footer/links are derived from the findings).
// ---------------------------------------------------------------------------

function toReportViewModel(a: HealthAssessment): ReportViewModel {
  const findings = [a.flow, a.execution, a.liveness];
  return {
    title: "health",
    scope: a.scope,
    period: a.period,
    baselineLabel: a.baselineLabel,
    generatedAt: a.generatedAt,
    windowMinutes: a.windowMinutes,
    summary: aggregateSummary(a.flow, a.execution, a.liveness, a.executionTreatedCrit),
    findings,
    metrics: a.metrics,
    facts: a.facts,
    links: collectLinks(findings),
    // Stale telemetry -> footer points at the control plane, not a CH-derived action.
    footer: buildFooter(findings, a.drain, a.telemetryStale),
  };
}

/** Public entry: data -> generic report. Thin composition of the domain + presentation layers. */
export function interpret(input: HealthInput): ReportViewModel {
  return toReportViewModel(assessHealth(input));
}

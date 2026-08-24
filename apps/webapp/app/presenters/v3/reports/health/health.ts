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
import {
  buildMetrics,
  computeDrain,
  HEALTH_THRESHOLDS,
  isPendingUnknown,
  type HealthInput,
} from "./health-core";
import { buildExecutionRead, interpretExecution } from "./execution";
import { applyFlowPolicy, buildFlowRead, FLOW_UNMEASURED, interpretFlow } from "./flow";
import { interpretLiveness } from "./liveness";

export { HEALTH_THRESHOLDS, isPendingIncreasing, type HealthInput } from "./health-core";

// Flow and execution are both ClickHouse-derived, so stale telemetry makes both unknown and strips
// anything that would advise action.
function applyStaleGuard(
  flow: Finding,
  execution: Finding,
  telemetryStale: boolean
): { flow: Finding; execution: Finding; treatedCrit: boolean } {
  if (!telemetryStale) return { flow, execution, treatedCrit: false };
  // Force crit so severity is consistent across summary, glyph and JSON.
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
      // Both exceptions mean "we can't say", so the statement renders no severity claim.
      reason:
        flow.reason === "unknown" || flow.reason === FLOW_UNMEASURED ? flow.reason : undefined,
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

  const footer: FooterEntry[] =
    dominant.recommendation.code === "raise_env_limit"
      ? [
          { code: "raise_env_limit", link: dominant.recommendation.link },
          { code: "concurrency_docs", link: dominant.recommendation.link },
        ]
      : [{ code: dominant.recommendation.code, link: dominant.recommendation.link }];

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

// The health verdict. All health semantics live here and no presentation does.
type HealthAssessment = {
  scope: string;
  period: string;
  baselineLabel: string;
  generatedAt: string;
  windowMinutes: number;
  /** Finalized findings: post-policy, post-stale-guard, with reads built. */
  flow: Finding;
  execution: Finding;
  liveness: Finding;
  metrics: Metric[];
  drain: { drainMinutes: number; isDrainable: boolean };
  telemetryStale: boolean;
  executionTreatedCrit: boolean;
  /** Structured payload for agents. Carries `trustworthy`. */
  facts: Record<string, unknown>;
};

function assessHealth(input: HealthInput): HealthAssessment {
  const metrics = buildMetrics(input);
  const drain = computeDrain(input);

  let flow = interpretFlow(metrics, input);
  const executionRaw = interpretExecution(metrics, input);
  const liveness = interpretLiveness(metrics, input);

  // "none" is not "lagging", and only genuine staleness trust-guards the verdicts. A signal-less env
  // stays neutral for the reader but reports `trustworthy: false`.
  const ageMs = input.liveness.telemetryAgeMs;
  const telemetry: "none" | "fresh" | "lagging" | "stale" =
    ageMs === null
      ? "none"
      : ageMs > HEALTH_THRESHOLDS.liveness.staleMs
        ? "stale"
        : ageMs > HEALTH_THRESHOLDS.liveness.freshMs
          ? "lagging"
          : "fresh";
  const telemetryStale = telemetry === "stale";
  const flowUnmeasured = isPendingUnknown(input);

  flow = applyFlowPolicy(flow, executionRaw, drain.isDrainable, telemetryStale);

  const guarded = applyStaleGuard(flow, executionRaw, telemetryStale);
  flow = guarded.flow;
  const execution = guarded.execution;

  // interpretFlow annotates the shared metrics array before the guard runs, and format=json would
  // leak that stale-derived narrative.
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
      // Metrics are informational unless this is true. Stale, absent and unmeasurable all read false.
      trustworthy: !telemetryStale && telemetry !== "none" && !flowUnmeasured,
      telemetry,
      untrustworthyReason: telemetryStale
        ? "telemetry_stale"
        : telemetry === "none"
          ? "telemetry_absent"
          : flowUnmeasured
            ? "flow_unmeasured"
            : undefined,
      flowSource: input.flowSource,
      pendingEstimated: input.pending.estimated,
      throughput: input.throughput,
      flowEvidence: input.flowEvidence,
    },
  };
}

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
    footer: buildFooter(findings, a.drain, a.telemetryStale),
  };
}

export function interpret(input: HealthInput): ReportViewModel {
  return toReportViewModel(assessHealth(input));
}

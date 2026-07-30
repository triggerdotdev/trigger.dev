/**
 * FLOW analyzer: "is work flowing, and if not, WHY?" Diagnosed by a CAUSE TREE — `flow.reason`
 * names why work is backing up (env_limit_saturation, dequeue_stall, …), selected from flow's
 * evidence, falling back to v1 symptom reasons when no discriminator fires. Evidence quantities
 * carry no severity of their own — they only select the cause.
 */

import {
  anomalyWindow,
  isOk,
  maxSeverity,
  type Exclusion,
  type Finding,
  type Metric,
  type Observation,
  type Recommendation,
  type Severity,
} from "../report-view-model";
import {
  HEALTH_THRESHOLDS,
  isPendingIncreasing,
  mean,
  metricById,
  type HealthInput,
} from "./health-core";

export const FLOW_METRIC_IDS = ["start_latency_p95", "pending", "throughput"];

/** One row of the declarative cause table — everything a cause defines about itself. */
type CauseSpec = {
  reason: string;
  metricIds: string[]; // real metric rows, causal order
  drivingMetricId: string; // series for the anomaly window
  annotationCode?: string; // set on the driving metric
  exclusions: Exclusion[]; // ruled-out causes ("not your code")
  observations: Observation[]; // supporting facts ("runs are completing at ~X/min")
  recommendation: Recommendation;
  usesAttribution: boolean; // append the worst-queue attribution line
};

export function interpretFlow(metrics: Metric[], input: HealthInput): Finding {
  const t = HEALTH_THRESHOLDS.flowCause;
  const ev = input.flowEvidence;
  const flowMetrics = FLOW_METRIC_IDS.map((id) => metricById(metrics, id));
  const severity = maxSeverity(...flowMetrics.map((m) => m.severity));

  if (isOk(severity)) {
    return { type: "flow", severity, reason: "healthy", metricIds: FLOW_METRIC_IDS };
  }

  // Discriminators (evidence only, no own severity).
  const pendingIncreasing = isPendingIncreasing(input.pending.series);
  const latencyElevated = !isOk(metricById(metrics, "start_latency_p95").severity);
  // Concurrency causes need real running-capacity evidence — without it runningShare is a
  // meaningless 0 and would falsely select dequeue_stall on the snapshot path (#1).
  const hasConcurrencyEvidence = ev.envLimit > 0 && ev.runningSeries.length > 0;
  const runningShare = hasConcurrencyEvidence ? mean(ev.runningSeries) / ev.envLimit : 1;
  const pinnedShare = hasConcurrencyEvidence
    ? ev.runningSeries.filter((r) => r >= t.pinnedLevel * ev.envLimit).length /
      ev.runningSeries.length
    : 0;
  const pinned = pinnedShare >= t.pinnedShare;
  const hasTriggerBaseline = input.throughput.normalTriggeredPerMin > 0;
  const triggeredMult = hasTriggerBaseline
    ? input.throughput.triggeredPerMin / input.throughput.normalTriggeredPerMin
    : 0;
  // No baseline: a multiplier can't be computed, so an absolute rate selects "new volume".
  const triggerSurge = !hasTriggerBaseline && input.throughput.triggeredPerMin >= t.surgePerMin;

  const donePerMin = input.throughput.donePerMin;
  const net = donePerMin - input.throughput.triggeredPerMin;
  // Exclusions must be PROVEN, not assumed. "not your code" needs healthy execution; "limits
  // aren't the bottleneck" needs no env-pin AND no queue throttling; the workers/spike ones
  // state a measured fact (rate) rather than a global "everything's fine" claim.
  const executionHealthy =
    isOk(metricById(metrics, "failures").severity) && isOk(metricById(metrics, "dur_p95").severity);
  const queueThrottled = ev.throttledShare >= t.throttledShare;
  const configHealthy = !pinned && !queueThrottled;
  // A trigger spike/surge is only the CAUSE of a backup when work is actually piling up:
  // completions falling behind (net < 0) AND the backlog trending up. Without this a spike that
  // drains fine would still be blamed while its read says "queue fills faster than it drains".
  const triggerBacklog = net < 0 && pendingIncreasing;

  // First discriminator that fires wins (fixed priority). dequeue_stall is a last-resort
  // "it's on our side" cause — so a known config bottleneck (queue throttling) must rule it
  // out first, else throttled-but-idle-capacity is misread as a platform stall (#1).
  let spec: CauseSpec;
  if (
    hasConcurrencyEvidence &&
    !queueThrottled &&
    runningShare < t.stallRunningShare &&
    pendingIncreasing &&
    latencyElevated
  ) {
    spec = {
      reason: "dequeue_stall",
      metricIds: ["concurrency", "pending", "start_latency_p95"],
      drivingMetricId: "concurrency",
      annotationCode: "idle_share",
      exclusions: [
        ...(executionHealthy ? [{ code: "not_your_code" }] : []),
        ...(configHealthy ? [{ code: "not_your_config" }] : []),
      ],
      observations: [],
      recommendation: { code: "check_platform_status", link: "status" },
      usesAttribution: false,
    };
  } else if (pinned && pendingIncreasing) {
    spec = {
      reason: "env_limit_saturation",
      metricIds: ["concurrency", "pending", "start_latency_p95"],
      drivingMetricId: "concurrency",
      annotationCode: "pinned_minutes",
      exclusions: [],
      // States a measured fact (runs ARE completing at {rate}/min) — evidence the workers aren't
      // dead. An observation, not an exclusion: it doesn't claim it's the limit, nor "keeps pace".
      observations:
        donePerMin > 0 ? [{ code: "not_workers_platform", evidence: { donePerMin } }] : [],
      recommendation: { code: "raise_env_limit", link: "concurrency" },
      usesAttribution: true,
    };
  } else if (ev.throttledShare >= t.throttledShare && !pinned) {
    spec = {
      reason: "queue_limit_throttling",
      metricIds: ["throttled", "pending"],
      drivingMetricId: "throttled",
      annotationCode: "throttled_minutes",
      // Justified: we're in the not-pinned branch, so the env limit isn't the bottleneck.
      exclusions: [{ code: "not_env_limit" }],
      observations: [],
      recommendation: { code: "raise_queue_limit", link: "queue" },
      usesAttribution: true,
    };
  } else if (triggeredMult >= t.spikeMult && triggerBacklog) {
    spec = {
      reason: "trigger_spike",
      metricIds: ["triggered", "pending", "start_latency_p95"],
      drivingMetricId: "triggered",
      annotationCode: "spike_mult",
      exclusions: [],
      // Only the proven fact — the runs that DO start execute fine. An observation, NOT the
      // exclusion "not your code": healthy execution doesn't prove the code isn't the one
      // triggering the flood (e.g. a deploy that fans out task.trigger in a loop).
      observations: executionHealthy ? [{ code: "execution_healthy" }] : [],
      recommendation: { code: "review_trigger_source", link: "runs" },
      usesAttribution: false,
    };
  } else if (triggerSurge && triggerBacklog) {
    spec = {
      reason: "trigger_surge",
      metricIds: ["triggered", "pending", "start_latency_p95"],
      drivingMetricId: "triggered",
      annotationCode: "surge_rate",
      exclusions: [],
      // Same as a spike: only the proven fact, without ruling out the trigger-producing code.
      observations: executionHealthy ? [{ code: "execution_healthy" }] : [],
      recommendation: { code: "review_trigger_source", link: "runs" },
      usesAttribution: false,
    };
  } else {
    // Fallback — v1 symptom reasons by dominant metric.
    return fallbackFlow(flowMetrics, severity);
  }

  return assembleFlowCause(spec, metrics, input, severity);
}

/** Build a flow Finding from a cause spec: annotation, anomaly window, attribution, evidence. */
function assembleFlowCause(
  spec: CauseSpec,
  metrics: Metric[],
  input: HealthInput,
  severity: Severity
): Finding {
  const t = HEALTH_THRESHOLDS;
  const driving = metricById(metrics, spec.drivingMetricId);

  // Anomaly window from the driving series. env_limit_saturation breaches ABOVE
  // (concurrency pinned at the limit); dequeue_stall breaches BELOW (capacity idle).
  // NOTE: runningSeries is at native env_metrics resolution (not resampled), so the "(last N
  // min)" figure assumes those buckets are uniform and cover the resolved window. env_metrics
  // are emitted on a fixed cadence, so that holds; a gappy/partial window could skew the minutes.
  let aw: Finding["anomalyWindow"];
  if (spec.reason === "env_limit_saturation" || spec.reason === "dequeue_stall") {
    const below = spec.reason === "dequeue_stall";
    const threshold = below
      ? t.flowCause.stallRunningShare * input.flowEvidence.envLimit
      : t.flowCause.pinnedLevel * input.flowEvidence.envLimit;
    aw = anomalyWindow(input.flowEvidence.runningSeries, threshold, input.windowMinutes, { below });
  }

  // Annotation on the driving metric (a fact, not an invented number).
  if (spec.annotationCode) {
    const value =
      spec.annotationCode === "pinned_minutes"
        ? (aw?.minutes ?? 0)
        : spec.annotationCode === "idle_share"
          ? // mean running over the window ("N running of {limit}").
            Math.round(mean(input.flowEvidence.runningSeries))
          : spec.annotationCode === "spike_mult"
            ? Math.round(
                input.throughput.normalTriggeredPerMin > 0
                  ? input.throughput.triggeredPerMin / input.throughput.normalTriggeredPerMin
                  : 0
              )
            : spec.annotationCode === "throttled_minutes"
              ? Math.round(input.flowEvidence.throttledShare * input.windowMinutes)
              : spec.annotationCode === "surge_rate"
                ? Math.round(input.throughput.triggeredPerMin)
                : Math.round(driving.value);
    driving.annotation = { code: spec.annotationCode, value };
  }

  // Attribution — only when a queue owns >= minShare of the problem.
  let attribution: Finding["attribution"];
  const wq = input.flowEvidence.worstQueue;
  if (spec.usesAttribution && wq && wq.share >= t.attribution.minShare) {
    attribution = { dim: "queue", key: wq.name, share: wq.share, of: "pending" };
  }

  // Append "nothing dead-lettered" ONLY on a measured zero (dlqDelta === 0); null means
  // unmeasured (snapshot path) — no observation without evidence. It's a supporting fact, not a
  // ruled-out cause, so it joins observations.
  const observations =
    input.flowEvidence.dlqDelta === 0
      ? [...spec.observations, { code: "nothing_dead_lettered", evidence: { dlq: 0 } }]
      : spec.observations;

  return {
    type: "flow",
    severity,
    reason: spec.reason,
    metricIds: spec.metricIds,
    recommendation: spec.recommendation,
    anomalyWindow: aw,
    attribution,
    exclusions: spec.exclusions,
    observations,
  };
}

/** v1 symptom fallback when no cause discriminator fires. */
function fallbackFlow(flowMetrics: Metric[], severity: Severity): Finding {
  const firstOff = flowMetrics.find((m) => !isOk(m.severity));
  const reason =
    firstOff?.id === "start_latency_p95"
      ? "start_latency"
      : firstOff?.id === "pending"
        ? "backlog"
        : firstOff?.id === "throughput"
          ? "throughput_lag"
          : "degraded";
  const recommendation =
    reason === "start_latency"
      ? { code: "review_start_latency", link: "queue_latency" }
      : reason === "backlog"
        ? { code: "check_queue_health", link: "queues" }
        : reason === "throughput_lag"
          ? { code: "check_worker_availability", link: "queues" }
          : undefined;
  return {
    type: "flow",
    severity,
    reason,
    metricIds: FLOW_METRIC_IDS,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Flow severity policy + the causal "read:" line.
// ---------------------------------------------------------------------------

export function applyFlowPolicy(
  flow: Finding,
  execution: Finding,
  isDrainable: boolean,
  telemetryStale: boolean
): Finding {
  if (flow.severity !== "crit") return flow;
  // Downgrade a drainable crit to warn only when execution is fine and telemetry isn't stale.
  // Unknown/lagging freshness must NOT block this (it's not a signal that anything's wrong).
  const severity: Severity =
    isOk(execution.severity) && !telemetryStale && isDrainable ? "warn" : "crit";
  return { ...flow, severity };
}

const CAUSE_READS: Record<string, string> = {
  dequeue_stall: "capacity_free_not_dequeuing",
  env_limit_saturation: "saturation_chain",
  queue_limit_throttling: "queue_throttle_chain",
  trigger_spike: "spike_chain",
  trigger_surge: "surge_chain",
};

export function buildFlowRead(flow: Finding, executionOk: boolean, livenessFresh: boolean): string {
  if (flow.reason === "unknown") return "data_stale"; // stale-guarded — no causal read
  if (isOk(flow.severity)) return "starting_normally";
  if (CAUSE_READS[flow.reason]) return CAUSE_READS[flow.reason];
  // fallback symptoms (v1 logic)
  if (executionOk && livenessFresh) return "lag_while_triggering_normal";
  if (!executionOk) return "lag_and_failures";
  return "degraded_generic";
}

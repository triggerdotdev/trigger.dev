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
  bucketCoverage,
  HEALTH_THRESHOLDS,
  isPendingIncreasing,
  isPendingUnknown,
  mean,
  metricById,
  type HealthInput,
} from "./health-core";

const FLOW_METRIC_IDS = ["start_latency_p95", "pending", "throughput"];

/** Unmeasurable backlog: verdict is unassessable. Distinct from "unknown", the staleness guard. */
export const FLOW_UNMEASURED = "flow_unmeasured";

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

  // `pending.now` is a placeholder here, so no cause tree may hang off it. What `runs` measured still
  // stands: only a flow with nothing measurably wrong is unassessable, the rest reports its symptom.
  if (isPendingUnknown(input)) {
    return isOk(severity)
      ? { type: "flow", severity, reason: FLOW_UNMEASURED, metricIds: FLOW_METRIC_IDS }
      : fallbackFlow(flowMetrics, severity);
  }

  if (isOk(severity)) {
    return { type: "flow", severity, reason: "healthy", metricIds: FLOW_METRIC_IDS };
  }

  const pendingIncreasing = isPendingIncreasing(input.pending.series);
  const latencyElevated = !isOk(metricById(metrics, "start_latency_p95").severity);
  // Without real running-capacity evidence runningShare is a meaningless 0 that selects
  // dequeue_stall; without enough arrived buckets a few fresh ones read as pinned all window.
  const coverage = bucketCoverage(input);
  const hasConcurrencyEvidence =
    ev.envLimit > 0 && ev.runningSeries.length > 0 && coverage.sufficient;
  const runningShare = hasConcurrencyEvidence ? mean(ev.runningSeries) / ev.envLimit : 1;
  // Pinned share is measured against expected buckets, not received rows.
  const pinnedShare = hasConcurrencyEvidence
    ? ev.runningSeries.filter((r) => r >= t.pinnedLevel * ev.envLimit).length /
      coverage.expectedBuckets
    : 0;
  const pinned = pinnedShare >= t.pinnedShare;
  const hasTriggerBaseline = input.throughput.normalTriggeredPerMin > 0;
  const triggeredMult = hasTriggerBaseline
    ? input.throughput.triggeredPerMin / input.throughput.normalTriggeredPerMin
    : 0;
  // No baseline means no multiplier, so an absolute rate selects "new volume".
  const triggerSurge = !hasTriggerBaseline && input.throughput.triggeredPerMin >= t.surgePerMin;

  // Work leaves the queue on any terminal status, not just completions.
  const finishedPerMin = input.throughput.finishedPerMin;
  const net = finishedPerMin - input.throughput.triggeredPerMin;
  // "not your config" requires both no env pin and no queue throttling.
  const executionHealthy =
    isOk(metricById(metrics, "failures").severity) && isOk(metricById(metrics, "dur_p95").severity);
  const queueThrottled = ev.throttledShare >= t.throttledShare;
  const configHealthy = !pinned && !queueThrottled;
  // A spike is only a cause when work piles up: finishes behind triggers and backlog trending up.
  const triggerBacklog = net < 0 && pendingIncreasing;

  // First discriminator wins. dequeue_stall is last resort: a known config bottleneck rules it out.
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
      observations:
        finishedPerMin > 0 ? [{ code: "not_workers_platform", evidence: { finishedPerMin } }] : [],
      recommendation: { code: "raise_env_limit", link: "concurrency" },
      usesAttribution: true,
    };
  } else if (ev.throttledShare >= t.throttledShare && !pinned) {
    spec = {
      reason: "queue_limit_throttling",
      metricIds: ["throttled", "pending"],
      drivingMetricId: "throttled",
      annotationCode: "throttled_minutes",
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
      observations: executionHealthy ? [{ code: "execution_healthy" }] : [],
      recommendation: { code: "review_trigger_source", link: "runs" },
      usesAttribution: false,
    };
  } else {
    return fallbackFlow(flowMetrics, severity);
  }

  return assembleFlowCause(spec, metrics, input, severity);
}

function assembleFlowCause(
  spec: CauseSpec,
  metrics: Metric[],
  input: HealthInput,
  severity: Severity
): Finding {
  const t = HEALTH_THRESHOLDS;
  const driving = metricById(metrics, spec.drivingMetricId);

  // env_limit_saturation breaches above the threshold, dequeue_stall below it. runningSeries is not
  // gap-filled, so the duration counts per real bucket cadence and gaps break the contiguous run.
  let aw: Finding["anomalyWindow"];
  if (spec.reason === "env_limit_saturation" || spec.reason === "dequeue_stall") {
    const below = spec.reason === "dequeue_stall";
    const threshold = below
      ? t.flowCause.stallRunningShare * input.flowEvidence.envLimit
      : t.flowCause.pinnedLevel * input.flowEvidence.envLimit;
    const coverage = bucketCoverage(input);
    aw = anomalyWindow(input.flowEvidence.runningSeries, threshold, input.windowMinutes, {
      below,
      bucketMinutes: coverage.known ? coverage.bucketMinutes : undefined,
      timestampsMs: input.flowEvidence.runningBucketsMs,
    });
  }

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

  let attribution: Finding["attribution"];
  const wq = input.flowEvidence.worstQueue;
  if (spec.usesAttribution && wq && wq.share >= t.attribution.minShare) {
    attribution = { dim: "queue", key: wq.name, share: wq.share, of: "pending" };
  }

  // Only a measured zero supports "nothing dead-lettered". Null means unmeasured.
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

export function applyFlowPolicy(
  flow: Finding,
  execution: Finding,
  isDrainable: boolean,
  telemetryStale: boolean
): Finding {
  if (flow.severity !== "crit") return flow;
  // Downgrade a drainable crit to warn only when execution is fine and telemetry isn't stale.
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
  if (flow.reason === "unknown") return "data_stale";
  if (flow.reason === FLOW_UNMEASURED) return "flow_unmeasured";
  if (isOk(flow.severity)) return "starting_normally";
  if (CAUSE_READS[flow.reason]) return CAUSE_READS[flow.reason];
  if (executionOk && livenessFresh) return "lag_while_triggering_normal";
  if (!executionOk) return "lag_and_failures";
  return "degraded_generic";
}

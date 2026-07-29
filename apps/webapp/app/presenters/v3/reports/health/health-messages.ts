/**
 * The `health` report's PROSE — the single place its codes resolve to strings. Registered
 * under the "health" title so the generic renderer can look it up by `vm.title` without ever
 * importing health vocabulary. A future report (Cost, Regression) ships its own catalog the
 * same way; `report-messages.ts` stays report-agnostic infrastructure.
 *
 * Some strings carry {tokens} (e.g. {age}, {rate}) the renderer fills from the finding's
 * metrics / evidence — meaning lives here, numbers stay facts.
 */

import { registerReportMessages, type ReportMessages } from "../report-messages";
import { type ReasonCode, type Severity } from "../report-view-model";

/** Metric id -> expanded display label. */
const METRIC_LABELS: Record<string, string> = {
  start_latency_p95: "start latency",
  pending: "pending",
  throughput: "throughput",
  failures: "failures",
  dur_p95: "p95 dur",
  liveness: "liveness",
  concurrency: "concurrency",
  throttled: "throttled",
  triggered: "triggered",
};

/**
 * Finding headline — keyed by `${findingType}/${reason}`. Degraded = the cause,
 * healthy = reassurance. `@expanded` variants show a healthy finding expanded
 * (e.g. execution while flow is degraded).
 */
const FINDING_REASONS: Record<string, string> = {
  // flow — causes
  "flow/env_limit_saturation": "at your env concurrency limit",
  "flow/dequeue_stall": "capacity is free but nothing is dequeuing",
  "flow/queue_limit_throttling": "a queue is throttling at its own limit",
  "flow/trigger_spike": "a trigger spike is backing up the queue",
  "flow/trigger_surge": "a surge of new triggers is backing up the queue",
  // flow — fallback symptoms (v1)
  "flow/start_latency": "runs are slow to start",
  "flow/backlog": "backlog is growing",
  "flow/throughput_lag": "completion is falling behind triggers",
  "flow/degraded": "flow is degraded",
  // flow — healthy (collapsed)
  "flow/healthy": "starting normally",
  // execution
  "execution/failures_up": "runs are failing more than usual",
  "execution/slow_runs": "runs are slower than usual",
  "execution/degraded": "execution is degraded",
  "execution/unknown": "execution can't be assessed — the telemetry is stale",
  "flow/unknown": "flow can't be assessed — the telemetry is stale",
  "execution/healthy": "completing normally", // collapsed
  "execution/healthy@expanded": "the runs that DO start are fine",
  // liveness = telemetry freshness ({age} filled by the renderer)
  "liveness/fresh": "fresh — telemetry current, updated {age} ago",
  "liveness/lagging": "lagging — telemetry last updated {age} ago",
  "liveness/stale": "stale — no telemetry in {age}",
  "liveness/freshness_unknown": "freshness unknown — no telemetry signal to check",
};

/** The "read:" causal-chain line — keyed by code. */
const READS: Record<string, string> = {
  // cause chains
  saturation_chain: "limit saturated → incoming work exceeds capacity → backlog grows",
  capacity_free_not_dequeuing: "capacity is free but work isn't being picked up — on our side",
  queue_throttle_chain: "queue at its limit → its runs wait → backlog grows",
  spike_chain: "triggers jumped {mult}× → queue fills faster than it drains",
  surge_chain: "new triggers arriving with no prior baseline → queue fills faster than it drains",
  // fallback symptoms (v1)
  starting_normally: "runs are starting on time",
  lag_while_triggering_normal: "triggering normally, but starts lag → work is backing up",
  lag_and_failures: "runs are lagging AND failing — check the code path",
  degraded_generic: "flow is degraded",
  not_a_code_problem: "NOT a code problem",
  runs_are_fine: "runs are completing normally",
  failures_elevated: "failures are elevated — check the code path",
  data_stale: "data is stale — the verdict cannot be trusted",
};

/** Exclusion (ruled-out cause) — rendered under `read:`. {tokens} filled from evidence. */
const EXCLUSIONS: Record<string, string> = {
  not_env_limit: "env concurrency limit is not the bottleneck",
  not_your_code: "not your code — failures and durations normal",
  not_your_config: "not your config — limits aren't the bottleneck",
};

/** Observation (supporting fact, not a ruled-out cause) — rendered under `read:` after exclusions. */
const OBSERVATIONS: Record<string, string> = {
  not_workers_platform: "runs are completing at ~{rate}/min",
  execution_healthy: "runs that start are completing normally",
  nothing_dead_lettered: "nothing dead-lettered",
};

/** Metric annotation shown on a cause line INSTEAD of "(normal ~x)". {tokens} filled by the renderer. */
const ANNOTATIONS: Record<string, string> = {
  pinned_minutes: "pinned {value} of last {window} min",
  idle_share: "idle — {value} running of {limit}",
  throttled_minutes: "throttled {value} of last {window} min",
  spike_mult: "{value}× the normal rate",
  surge_rate: "{value}/min, no prior baseline",
};

/** Headline statement — keyed by `${findingType}/${severity}`. */
const STATEMENTS: Record<string, string> = {
  "flow/ok": "Flow healthy",
  "flow/warn": "Flow slowing",
  "flow/crit": "Flow stalled",
  "execution/ok": "Execution healthy",
  "execution/warn": "Execution degraded",
  "execution/crit": "Execution failing",
  "liveness/ok": "data fresh",
  "liveness/warn": "data lagging",
  "liveness/crit": "data stale",
};

/** Recommendation / footer codes -> calm, jargon-free action text. */
const ACTIONS: Record<string, string> = {
  // Review = open concrete data · Check = system state · Raise = a settings change
  review_start_latency: "Review start latency",
  review_failing_tasks: "Review failing tasks",
  review_slow_runs: "Review slow runs",
  review_trigger_source: "Review what's triggering the spike",
  check_queue_health: "Check queue health",
  check_worker_availability: "Check worker availability",
  check_control_plane: "Check control plane",
  check_platform_status: "Check status.trigger.dev — no action needed on yours",
  raise_env_limit: "Raise the env concurrency limit",
  raise_queue_limit: "Raise the queue's concurrency limit",
  do_nothing_drains: "or do nothing — backlog drains in ~{value} min once triggers ease",
  region_failover: "region move? ask your agent — depends on your failover setup",
  nothing_to_do: "nothing to do",
};

function findingReason(
  findingType: string,
  reason: ReasonCode,
  opts?: { expanded?: boolean }
): string {
  if (opts?.expanded) {
    const expanded = FINDING_REASONS[`${findingType}/${reason}@expanded`];
    if (expanded) return expanded;
  }
  return FINDING_REASONS[`${findingType}/${reason}`] ?? reason;
}

function statementMessage(findingType: string, severity: Severity, reason?: ReasonCode): string {
  // Stale telemetry makes a CH-derived verdict untrustworthy — say so, don't show a severity.
  if (reason === "unknown") {
    const label = findingType.charAt(0).toUpperCase() + findingType.slice(1);
    return `${label} unknown — data stale`;
  }
  // No freshness signal is NOT "data lagging" (a real severity) — it's genuinely unknown.
  if (findingType === "liveness" && reason === "freshness_unknown") {
    return "data freshness unknown";
  }
  return STATEMENTS[`${findingType}/${severity}`] ?? `${findingType} ${severity}`;
}

export const healthMessages: ReportMessages = {
  metricLabel: (id) => METRIC_LABELS[id] ?? id,
  findingReason,
  readMessage: (code) => READS[code] ?? code,
  exclusionMessage: (code) => EXCLUSIONS[code] ?? code,
  observationMessage: (code) => OBSERVATIONS[code] ?? code,
  annotationMessage: (code) => ANNOTATIONS[code] ?? code,
  statementMessage,
  actionMessage: (code) => ACTIONS[code] ?? code,
};

registerReportMessages("health", healthMessages);

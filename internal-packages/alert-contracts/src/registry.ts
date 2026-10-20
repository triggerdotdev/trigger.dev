import type { AlertCapability, AlertScopeType, AlertSurface } from "./schemas.js";

export const CURRENTLY_QUEUED_PREDICATE_PENDING =
  "status = 'PENDING' AND queued_at IS NOT NULL AND dequeued_at IS NULL";

const ALL_SURFACES: AlertSurface[] = ["alerts_page", "contextual", "agent", "mcp"];
const NO_CONTEXTUAL: AlertSurface[] = ["alerts_page", "agent", "mcp"];

const QUEUE_SCOPES: AlertScopeType[] = ["queue", "queuePattern", "all"];
const RUN_SCOPES: AlertScopeType[] = ["task", "all"];
const HEALTH_SCOPES: AlertScopeType[] = ["all"];
const ERROR_GROUP_SCOPES: AlertScopeType[] = ["errorGroup"];

const FAILED_RUN_PREDICATE =
  "status IN ('CRASHED', 'SYSTEM_FAILURE', 'TIMED_OUT', 'COMPLETED_WITH_ERRORS')";

export const V1_CAPABILITIES: AlertCapability[] = [
  {
    key: "queue.depth",
    area: "queues",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template:
        "SELECT queue, max(max_queued) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
      table: "concurrency_metrics",
      minCadenceSec: 300,
    },
    minCadenceSec: 300,
    title: "Queue depth",
    description:
      "Number of runs waiting in a queue, as a count. Measured as the peak queue length in each evaluation window.",
    unit: "count",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "gauge",
    allowedScopes: QUEUE_SCOPES,
  },
  {
    key: "queue.oldest_age",
    area: "queues",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template: `SELECT max(dateDiff('millisecond', queued_at, now())) FROM runs WHERE {{scope}} AND ${CURRENTLY_QUEUED_PREDICATE_PENDING}`,
      table: "runs",
      minCadenceSec: 600,
    },
    minCadenceSec: 600,
    title: "Oldest queued run age",
    description:
      "Age of the oldest run still waiting in the queue, in milliseconds. Measured every evaluation.",
    unit: "duration_ms",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "snapshot",
    allowedScopes: QUEUE_SCOPES,
  },
  {
    key: "queue.concurrency",
    area: "queues",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template:
        "SELECT queue, if(max(max_limit) > 0, max(max_running) / max(max_limit) * 100, 0) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
      table: "concurrency_metrics",
      minCadenceSec: 300,
    },
    minCadenceSec: 300,
    title: "Queue concurrency",
    description:
      "Share of a queue's concurrency limit in use, as a percentage. Measured as peak running runs divided by the limit.",
    unit: "percent",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "gauge",
    allowedScopes: QUEUE_SCOPES,
  },
  {
    key: "queue.stalled",
    area: "queues",
    signal: "state",
    allowedKinds: ["state"],
    binding: {
      type: "query",
      template:
        "SELECT max(max_queued) > 0 AND deltaSumTimestampMerge(started_delta) = 0 FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
      table: "concurrency_metrics",
      minCadenceSec: 300,
    },
    minCadenceSec: 300,
    title: "Queue stalled",
    description:
      "Whether a queue has runs waiting but none starting. True when the queue is non-empty and no run started in the window.",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "gauge",
    allowedScopes: QUEUE_SCOPES,
  },
  {
    key: "queue.scheduling_delay_p95",
    area: "queues",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template:
        "SELECT quantilesMerge(0.95)(wait_quantiles)[1] FROM concurrency_metrics WHERE {{scope}}",
      table: "concurrency_metrics",
      minCadenceSec: 300,
    },
    minCadenceSec: 300,
    title: "Scheduling delay (p95)",
    description:
      "95th percentile of the time between a run being queued and starting, in milliseconds. Measured over the evaluation window.",
    unit: "duration_ms",
    surfaces: ALL_SURFACES,
    curated: false,
    freshness: "gauge",
    allowedScopes: QUEUE_SCOPES,
  },
  {
    key: "runs.volume",
    area: "runs",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template: "SELECT count() FROM runs WHERE {{scope}}",
      table: "runs",
      minCadenceSec: 600,
    },
    minCadenceSec: 600,
    title: "Run volume",
    description: "Number of runs triggered in the evaluation window, as a count.",
    unit: "count",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "counter",
    allowedScopes: RUN_SCOPES,
  },
  {
    key: "runs.duration_p95",
    area: "runs",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template:
        "SELECT quantile(0.95)(execution_duration) FROM runs WHERE {{scope}} AND is_finished = 1",
      table: "runs",
      minCadenceSec: 600,
    },
    minCadenceSec: 600,
    title: "Duration (p95)",
    description:
      "95th percentile of execution time of finished runs, in milliseconds. Measured over the evaluation window.",
    unit: "duration_ms",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "gauge",
    allowedScopes: RUN_SCOPES,
  },
  {
    key: "runs.created",
    area: "runs",
    signal: "event",
    allowedKinds: ["absence"],
    binding: {
      type: "query",
      template: "SELECT count() FROM runs WHERE {{scope}}",
      table: "runs",
      minCadenceSec: 600,
    },
    minCadenceSec: 600,
    title: "Runs created",
    description:
      "Number of runs created in the evaluation window, as a count. Zero means no runs were triggered.",
    unit: "count",
    surfaces: ALL_SURFACES,
    curated: true,
    minWindowSec: 1800,
    freshness: "counter",
    allowedScopes: RUN_SCOPES,
  },
  {
    key: "runs.failure_rate",
    area: "runs",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template: `SELECT countIf(${FAILED_RUN_PREDICATE}) / count() * 100 FROM runs WHERE {{scope}} AND is_finished = 1`,
      table: "runs",
      minCadenceSec: 600,
    },
    minCadenceSec: 600,
    title: "Failure rate",
    description:
      "Share of finished runs that failed, as a percentage. Failed means crashed, system failure, timed out or completed with errors.",
    unit: "percent",
    surfaces: ALL_SURFACES,
    curated: false,
    freshness: "counter",
    allowedScopes: RUN_SCOPES,
  },
  {
    key: "runs.failed",
    area: "runs",
    signal: "metric",
    allowedKinds: ["threshold"],
    binding: {
      type: "query",
      template: `SELECT count() FROM runs WHERE {{scope}} AND ${FAILED_RUN_PREDICATE}`,
      table: "runs",
      minCadenceSec: 600,
    },
    minCadenceSec: 600,
    title: "Failed runs",
    description:
      "Number of runs that failed in the evaluation window, as a count. Failed means crashed, system failure, timed out or completed with errors.",
    unit: "count",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "counter",
    allowedScopes: RUN_SCOPES,
  },
  {
    key: "health.flow",
    area: "health",
    signal: "state",
    allowedKinds: ["state"],
    binding: {
      type: "query",
      template:
        "SELECT quantilesMerge(0.95)(wait_quantiles)[1] > {{p.schedulingDelayMs}} OR max(max_queued) > {{p.backlogCount}} OR if(max(max_queued) > 0, deltaSumTimestampMerge(started_delta) = 0, 0) FROM concurrency_metrics WHERE {{scope}} GROUP BY queue",
      table: "concurrency_metrics",
      minCadenceSec: 300,
      params: [
        {
          key: "schedulingDelayMs",
          label: "Scheduling delay p95",
          unit: "ms",
          default: 30000,
          min: 1000,
        },
        { key: "backlogCount", label: "Queued runs", default: 1000, min: 1 },
      ],
    },
    minCadenceSec: 300,
    title: "Health (Flow)",
    description:
      "Whether work is flowing through your queues. True when p95 scheduling delay or queued runs exceed their limits, or a queue has runs but none starting.",
    surfaces: NO_CONTEXTUAL,
    curated: true,
    freshness: "snapshot",
    allowedScopes: HEALTH_SCOPES,
  },
  {
    key: "health.execution",
    area: "health",
    signal: "state",
    allowedKinds: ["state"],
    binding: {
      type: "query",
      template:
        "SELECT countIf(status IN ('CRASHED','SYSTEM_FAILURE','TIMED_OUT','COMPLETED_WITH_ERRORS')) * 100 / if(count() = 0, 1, count()) > {{p.failureRatePct}} OR quantile(0.95)(execution_duration) > {{p.durationP95Ms}} FROM runs WHERE {{scope}} AND is_finished = 1",
      table: "runs",
      minCadenceSec: 600,
      params: [
        {
          key: "failureRatePct",
          label: "Failure rate",
          unit: "percent",
          default: 10,
          min: 0,
          max: 100,
        },
        {
          key: "durationP95Ms",
          label: "Duration p95",
          unit: "ms",
          default: 300000,
          min: 1000,
        },
      ],
    },
    minCadenceSec: 600,
    title: "Health (Execution)",
    description:
      "Whether runs are executing well. True when the failure rate or p95 run duration of finished runs exceeds its limit.",
    surfaces: NO_CONTEXTUAL,
    curated: true,
    freshness: "snapshot",
    allowedScopes: HEALTH_SCOPES,
  },
  {
    key: "health.liveness",
    area: "health",
    signal: "state",
    allowedKinds: ["state"],
    binding: {
      type: "query",
      template:
        "SELECT dateDiff('second', max(triggered_at), now()) > {{p.silenceSec}} FROM runs WHERE {{scope}}",
      table: "runs",
      minCadenceSec: 600,
      params: [{ key: "silenceSec", label: "Silence", unit: "seconds", default: 300, min: 60 }],
      windowParam: "silenceSec",
    },
    minCadenceSec: 600,
    title: "Health (Liveness)",
    description:
      "Whether runs are still being triggered. True when the time since the latest run was triggered exceeds the silence limit, in seconds.",
    surfaces: NO_CONTEXTUAL,
    curated: true,
    freshness: "snapshot",
    allowedScopes: HEALTH_SCOPES,
  },
  {
    key: "health.all",
    area: "health",
    signal: "state",
    allowedKinds: ["state"],
    binding: {
      type: "query",
      minCadenceSec: 300,
      compositeOf: ["health.flow", "health.execution", "health.liveness"],
      params: [
        {
          key: "schedulingDelayMs",
          label: "Scheduling delay p95",
          unit: "ms",
          default: 30000,
          min: 1000,
        },
        { key: "backlogCount", label: "Queued runs", default: 1000, min: 1 },
        {
          key: "failureRatePct",
          label: "Failure rate",
          unit: "percent",
          default: 10,
          min: 0,
          max: 100,
        },
        {
          key: "durationP95Ms",
          label: "Duration p95",
          unit: "ms",
          default: 300000,
          min: 1000,
        },
        { key: "silenceSec", label: "Silence", unit: "seconds", default: 300, min: 60 },
      ],
    },
    minCadenceSec: 300,
    title: "Health (All)",
    description:
      "Combined state of flow, execution and liveness. True when any of the three checks is true.",
    surfaces: NO_CONTEXTUAL,
    curated: true,
    freshness: "snapshot",
    allowedScopes: HEALTH_SCOPES,
  },
  {
    key: "errors.new",
    area: "errors",
    signal: "event",
    allowedKinds: ["occurrence"],
    binding: {
      type: "query",
      emit: "rows",
      template:
        "SELECT task_identifier, error_fingerprint, min(first_seen) AS group_first_seen FROM errors WHERE {{scope}} GROUP BY task_identifier, error_fingerprint HAVING group_first_seen >= {{ctx.checkpoint}} AND group_first_seen < {{ctx.until}} AND {{ctx.after}} ORDER BY group_first_seen ASC, task_identifier ASC, error_fingerprint ASC",
      seriesTemplate:
        "SELECT toStartOfMinute(group_first_seen) AS bucket, count() AS new_groups FROM (SELECT task_identifier, error_fingerprint, min(first_seen) AS group_first_seen FROM errors WHERE {{scope}} GROUP BY task_identifier, error_fingerprint HAVING group_first_seen >= {{ctx.checkpoint}} AND group_first_seen < {{ctx.until}}) GROUP BY bucket ORDER BY bucket",
      table: "errors",
      ctx: ["checkpoint", "until", "after"],
      rowKey: ["task_identifier", "error_fingerprint"],
      fullRetention: true,
      minCadenceSec: 300,
    },
    minCadenceSec: 300,
    title: "New error",
    description:
      "Number of error groups seen for the first time in the evaluation window, as a count.",
    unit: "count",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "counter",
    allowedScopes: RUN_SCOPES,
  },
  {
    key: "errors.occurred_again",
    area: "errors",
    signal: "event",
    allowedKinds: ["occurrence"],
    binding: {
      type: "query",
      emit: "rows",
      template:
        "SELECT task_identifier, error_fingerprint, minute, sum(count) AS occurrences FROM error_occurrences WHERE {{scope}} AND minute >= {{ctx.checkpoint}} AND minute < {{ctx.until}} AND {{ctx.after}} GROUP BY task_identifier, error_fingerprint, minute ORDER BY minute ASC, task_identifier ASC, error_fingerprint ASC",
      seriesTemplate:
        "SELECT minute AS bucket, sum(count) AS occurrences FROM error_occurrences WHERE {{scope}} GROUP BY bucket ORDER BY bucket",
      table: "error_occurrences",
      ctx: ["checkpoint", "until", "after"],
      rowKey: ["task_identifier", "error_fingerprint", "minute"],
      minCadenceSec: 300,
    },
    minCadenceSec: 300,
    title: "This error occurs again",
    description:
      "Number of times a single error group occurred in the evaluation window, as a count.",
    unit: "count",
    surfaces: ALL_SURFACES,
    curated: true,
    freshness: "counter",
    allowedScopes: ERROR_GROUP_SCOPES,
  },
];

export function getCapability(key: string): AlertCapability | undefined {
  return V1_CAPABILITIES.find((c) => c.key === key);
}

export function listCapabilities(filter?: {
  area?: string;
  surface?: string;
  curatedOnly?: boolean;
}): AlertCapability[] {
  return V1_CAPABILITIES.filter((c) => {
    if (filter?.area && c.area !== filter.area) return false;
    if (filter?.surface && !c.surfaces.includes(filter.surface as AlertSurface)) return false;
    if (filter?.curatedOnly && !c.curated) return false;
    return true;
  });
}

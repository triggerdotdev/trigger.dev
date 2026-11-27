import type { QueueLimits } from "~/components/queues/queue-limits";
import { storedQueueName } from "~/components/queues/queue-name";
import type { Environment } from "~/presenters/v3/EnvironmentQueuePresenter.server";
import type {
  LimitsResult,
  QuotaInfo,
  RateLimitInfo,
} from "~/presenters/v3/LimitsPresenter.server";
import type { QueueAllocation } from "~/presenters/v3/QueueAllocationPresenter.server";
import type { QueueListMetric } from "~/presenters/v3/QueueMetricsPresenter.server";
import { QUEUE_ID } from "../schemas/queues";
import { untrusted } from "./logFields";

const NAME_CHARS = 200;
const KEY_CHARS = 200;
const MAX_KEYS = 50;
const DURATION = /^\d{1,6}(ms|s|m|h|d)$/;

export const QUEUE_METRICS_NOT_AVAILABLE = "Queue metrics are not available for this organization.";

export const NO_METRICS =
  "No metrics returned for this window: none were recorded, or the metrics store did not answer.";

type QueueRow = {
  id: string;
  name: string;
  type: "task" | "custom";
  kind?: "queue" | "limit";
  running: number;
  queued: number;
  paused: boolean;
  concurrencyLimitOverridePercent: number | null;
  limits: QueueLimits;
  archivedAt: Date | null;
};

type MetricsWindow = {
  period: string;
  from: Date;
  to: Date;
  bucketIntervalMs: number;
};

const queueName = (name: string) => untrusted(name, "queue-name", NAME_CHARS);

const queueId = (id: string) => (QUEUE_ID.test(id) ? id : untrusted(id, "queue-id", 80));

export const queueNotFound = (id: string) =>
  `Queue ${queueId(id)} was not found in this environment. Use list_queues to see the queues in this environment.`;

const count = (n: number) => (Number.isFinite(n) ? String(n) : "unknown");

function ms(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "none";
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

function perKeyText(limits: QueueLimits, percent: number | null, envLimit?: number): string {
  const { perKey } = limits;
  const current =
    perKey.current === null
      ? `none (the environment limit${envLimit === undefined ? "" : ` of ${envLimit}`} applies)`
      : String(perKey.current);
  if (perKey.override === null) return `${current}, set in code`;
  const source = percent !== null ? ` (${percent}% of the environment limit)` : "";
  const base = perKey.base === null ? "none" : String(perKey.base);
  return `${current}${source}, overridden; the limit set in code is ${base}`;
}

function totalText(limits: QueueLimits): string | undefined {
  const { total } = limits;
  if (!total) return undefined;
  if (total.override === null) return `${total.current}, set in code`;
  const base = total.base === null ? "none" : String(total.base);
  return `${total.current}, overridden; the limit set in code is ${base}`;
}

function queueLines(q: QueueRow, envLimit?: number): string[] {
  const state = [
    q.kind === "limit" ? "named concurrency limit" : `${q.type} queue`,
    q.paused ? "paused" : undefined,
    q.archivedAt ? "archived" : undefined,
  ].filter(Boolean);
  const lines = [
    `- ${queueName(q.name)} · ${queueId(q.id)} · ${state.join(", ")}`,
    `  Running ${count(q.running)} · queued ${count(q.queued)}`,
    `  Per-key limit: ${perKeyText(q.limits, q.concurrencyLimitOverridePercent, envLimit)}`,
  ];
  const total = totalText(q.limits);
  if (total) {
    const running = q.limits.total?.running;
    lines.push(
      `  Total limit: ${total}${running === null || running === undefined ? "" : ` · running across keys ${running}`}`
    );
  }
  return lines;
}

function windowLine(window: MetricsWindow): string {
  return `Metrics window: ${window.from.toISOString()} to ${window.to.toISOString()} (period ${window.period}), one point per ${window.bucketIntervalMs / 1000}s bucket.`;
}

function metricLines(metric: QueueListMetric | undefined, series: boolean): string[] {
  if (!metric) return [`  ${NO_METRICS}`];
  const lines = [
    `  Delay p50 ${ms(metric.p50WaitMs)} · p95 ${ms(metric.p95WaitMs)} · peak queued ${count(metric.peakQueued)} · throttled ${count(metric.throttledTotal)} times`,
  ];
  if (series) {
    lines.push(`  Backlog per bucket: ${metric.depthSparkline.map(count).join(",")}`);
    lines.push(`  Throttled per bucket: ${metric.throttledSparkline.map(count).join(",")}`);
  }
  return lines;
}

export function formatQueueList(input: {
  queues: QueueRow[];
  page: number;
  totalPages?: number;
  totalCount?: number;
  hasMore?: boolean;
  activeArchived: QueueRow[];
  metrics:
    | { window: MetricsWindow; byQueue: Map<string, QueueListMetric> }
    | "unavailable"
    | "not_read";
}): string {
  const lines: string[] = [];
  if (input.queues.length === 0) {
    lines.push(input.page > 1 ? `No queues on page ${input.page}.` : "No queues match.");
  } else {
    lines.push(
      `## Queues, page ${input.page}${
        input.totalPages ? ` of ${input.totalPages} (${input.totalCount} in total)` : ""
      }`
    );
    if (input.metrics === "unavailable") lines.push(QUEUE_METRICS_NOT_AVAILABLE);
    else if (input.metrics !== "not_read") lines.push(windowLine(input.metrics.window));
    lines.push("");
    for (const q of input.queues) {
      lines.push(...queueLines(q));
      if (typeof input.metrics === "object") {
        lines.push(...metricLines(input.metrics.byQueue.get(storedQueueName(q)), false));
      }
    }
  }
  const more = input.totalPages ? input.page < input.totalPages : input.hasMore;
  if (more) lines.push(`\nMore queues exist. Call again with page ${input.page + 1}.`);
  if (input.activeArchived.length > 0) {
    lines.push("\nArchived queues that still have queued or running runs:");
    for (const q of input.activeArchived) lines.push(...queueLines(q));
  }
  return lines.join("\n");
}

type ConcurrencyKeyBreakdown = {
  totalBackloggedKeys: number;
  keys: Array<{
    concurrencyKey: string;
    queued: number;
    running: number;
    oldestEnqueuedAt: number;
  }>;
};

/**
 * The earlier of the unkeyed head and the oldest keyed backlog. Both are the engine's queue
 * scores, which subtract priority, so this is a queue position rather than a measured wait.
 */
function oldestPositionMs(
  keys: ConcurrencyKeyBreakdown,
  oldestQueuedAt: number | null,
  now: number
) {
  const candidates = [
    ...keys.keys.filter((k) => k.queued > 0).map((k) => k.oldestEnqueuedAt),
    ...(oldestQueuedAt === null ? [] : [oldestQueuedAt]),
  ].filter(Number.isFinite);
  return candidates.length > 0 ? Math.max(0, now - Math.min(...candidates)) : null;
}

export function formatQueueDetails(input: {
  queue: QueueRow;
  envLimit: number;
  now: number;
  live:
    | {
        oldestQueuedAt: number | null;
        keys: ConcurrencyKeyBreakdown;
        window: MetricsWindow;
        metric: QueueListMetric | undefined;
      }
    | "unavailable";
}): string {
  const lines = [`## Queue`, ...queueLines(input.queue, input.envLimit), ""];
  if (input.live === "unavailable") {
    lines.push(QUEUE_METRICS_NOT_AVAILABLE);
    return lines.join("\n");
  }
  const { keys, oldestQueuedAt, window, metric } = input.live;
  const { now } = input;
  const oldest = oldestPositionMs(keys, oldestQueuedAt, now);
  lines.push(
    `Oldest queue position: ${oldest === null ? "none waiting" : `${ms(oldest)} ago (priority counts as waiting time)`}`,
    windowLine(window),
    ...metricLines(metric, true),
    "",
    `## Concurrency keys with queued runs (${keys.totalBackloggedKeys})`
  );
  if (keys.keys.length === 0) {
    lines.push("No concurrency key has queued runs right now.");
  } else {
    lines.push(`Most-starved first, up to ${MAX_KEYS}:`);
    for (const k of keys.keys) {
      lines.push(
        `- ${untrusted(k.concurrencyKey, "concurrency-key", KEY_CHARS)} · running ${count(k.running)} · queued ${count(k.queued)} · oldest position ${k.queued > 0 ? ms(Math.max(0, now - k.oldestEnqueuedAt)) : "none"}`
      );
    }
    if (keys.totalBackloggedKeys > keys.keys.length) {
      lines.push(
        `${keys.totalBackloggedKeys - keys.keys.length} more keys with queued runs are not listed.`
      );
    }
  }
  return lines.join("\n");
}

type EnvironmentPauseState = {
  paused: boolean;
  pauseSource: string | null;
};

function pausedBy(state: EnvironmentPauseState): string {
  if (!state.paused) return "not paused";
  switch (state.pauseSource) {
    case "BILLING_LIMIT":
      return "paused because the organization reached its billing limit";
    case "ADMIN_BAN":
      return "paused by an administrator";
    default:
      return "paused";
  }
}

export function formatEnvironmentConcurrency(input: {
  environment: Environment;
  pause: EnvironmentPauseState;
  allocation: QueueAllocation | "unavailable" | "failed";
}): string {
  const env = input.environment;
  const burst = Math.floor(env.concurrencyLimit * env.burstFactor);
  const lines = [
    "## Environment concurrency",
    `Running ${count(env.running)} · queued ${count(env.queued)}`,
    `Concurrency limit ${env.concurrencyLimit} · burst factor ${env.burstFactor} (up to ${burst} running at once across queues)`,
    `Max queued runs per queue: ${env.queueSizeLimit === null ? "no limit" : env.queueSizeLimit}`,
    `State: ${pausedBy(input.pause)}${env.runsEnabled ? "" : " · runs are disabled for this organization"}`,
  ];
  if (input.allocation === "unavailable") {
    lines.push(QUEUE_METRICS_NOT_AVAILABLE);
  } else if (input.allocation === "failed") {
    lines.push("Allocation could not be read. Try again later.");
  } else {
    const a = input.allocation;
    lines.push(
      `Allocated to queues: ${a.allocated} of ${env.concurrencyLimit} across ${a.totalQueues} queues; ${a.unlimitedCount} have no limit of their own and can use up to the environment limit.`
    );
  }
  return lines.join("\n");
}

function rateLimitText(info: RateLimitInfo): string {
  const c = info.config;
  const duration = (d: string) => (DURATION.test(d) ? d : "a custom interval");
  const shape =
    c.type === "tokenBucket"
      ? `${c.refillRate} tokens every ${duration(c.interval)}, up to ${c.maxTokens}`
      : `${c.tokens} requests per ${duration(c.window)} (${c.type === "fixedWindow" ? "fixed" : "sliding"} window)`;
  const now = info.currentTokens === null ? "unknown" : String(info.currentTokens);
  return `- ${info.name}: ${shape} · available now ${now}`;
}

function quotaText(q: QuotaInfo): string {
  const limit = q.limit === null ? "no limit" : `${q.limit}${q.unit ? ` ${q.unit}` : ""}`;
  const source =
    q.source === "plan" ? "from the plan" : q.source === "override" ? "custom" : "default";
  const usage = q.currentUsage > 0 ? ` · used ${q.currentUsage}` : "";
  const exceed = q.canExceed ? " · can be exceeded" : "";
  return `- ${q.name}: ${limit} (${source})${usage}${exceed}`;
}

/** No plan (self-hosted, or the billing lookup failed) says nothing about preview environments. */
const branchesWithoutQuota = (result: LimitsResult) =>
  result.planName === null
    ? "not available (no plan could be read)"
    : result.features.hasStagingEnvironment.enabled
      ? "the plan sets no limit"
      : "not on this plan (it has no preview environments)";

export function formatLimits(result: LimitsResult): string {
  const lines = [
    `## Limits${result.planName ? ` (${untrusted(result.planName, "plan-name", NAME_CHARS)} plan)` : ""}`,
    "",
    "Rate limits:",
    rateLimitText(result.rateLimits.api),
    rateLimitText(result.rateLimits.batch),
    "",
    "Quotas:",
  ];
  for (const quota of Object.values(result.quotas)) {
    if (quota) lines.push(quotaText(quota));
  }
  if (!result.quotas.branches) lines.push(`- Preview branches: ${branchesWithoutQuota(result)}`);
  lines.push("", "Plan features:");
  const { hasStagingEnvironment, support, includedUsage } = result.features;
  const usage = typeof includedUsage.value === "number" ? includedUsage.value : 0;
  lines.push(
    `- ${hasStagingEnvironment.name}: ${hasStagingEnvironment.enabled ? "yes" : "no"}`,
    `- ${support.name}: ${support.value === "Priority" ? "Priority" : "Community"}`,
    `- ${includedUsage.name}: ${includedUsage.enabled && usage > 0 ? `$${(usage / 100).toFixed(2)} per month` : "none"}`
  );
  return lines.join("\n");
}

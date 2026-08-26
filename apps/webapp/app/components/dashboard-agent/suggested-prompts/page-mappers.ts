/**
 * Route `handle` mappers: loader data in, `AgentPageContext` out. A mapper may
 * not cause a query, and signals are emitted only for abnormal state.
 */
import type { AgentPageContext, AgentPageSignal } from "@internal/dashboard-agent-contracts";
import { z } from "zod";
import { storedQueueName } from "~/components/queues/queue-name";
import { isQueueAtCapacity, OLDEST_WAIT_WARNING_MS } from "~/components/queues/queue-thresholds";

export const FRESH_FAILURE_WINDOW_MS = 30 * 60_000;

/** Mirrors the error set the run presenter uses for the root span (`isError`). */
const FAILED_STATUSES = new Set([
  "COMPLETED_WITH_ERRORS",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

/** Mirrors `QUEUED_STATUSES`. */
const WAITING_STATUSES = new Set(["PENDING", "PENDING_VERSION", "WAITING_FOR_DEPLOY", "DELAYED"]);

/** Mirrors `runStatusTitleFromStatus`; duplicated to keep this module React-free. */
const STATUS_LABELS: Record<string, string> = {
  DELAYED: "Delayed",
  PENDING: "Queued",
  PENDING_VERSION: "Pending version",
  WAITING_FOR_DEPLOY: "Pending version",
  DEQUEUED: "Dequeued",
  EXECUTING: "Executing",
  WAITING_TO_RESUME: "Waiting",
  RETRYING_AFTER_FAILURE: "Reattempting",
  PAUSED: "Paused",
  CANCELED: "Canceled",
  INTERRUPTED: "Interrupted",
  COMPLETED_SUCCESSFULLY: "Completed",
  COMPLETED_WITH_ERRORS: "Failed",
  SYSTEM_FAILURE: "System failure",
  CRASHED: "Crashed",
  EXPIRED: "Expired",
  TIMED_OUT: "Timed out",
};

const dateish = z.union([z.string(), z.date()]).nullish();

function toMillis(value: string | Date | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function toIso(value: string | Date | null | undefined): string | undefined {
  const ms = toMillis(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** `run.taskIdentifier` isn't in the loader payload; the run's span `message` is it. */
const runLoaderDataSchema = z.object({
  run: z.object({
    friendlyId: z.string(),
    status: z.string(),
    completedAt: dateish,
  }),
  trace: z
    .object({
      events: z
        .array(
          z.object({
            runId: z.string().nullish(),
            data: z.object({ message: z.string().nullish() }).nullish(),
          })
        )
        .nullish(),
    })
    .nullish(),
});

export function runAgentPageContext(
  data: unknown,
  now: number = Date.now()
): AgentPageContext | undefined {
  const parsed = runLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { run, trace } = parsed.data;
  const events = trace?.events ?? [];
  // The run's own span first: events[0] is the anchor in practice, but a truncated trace shifts it.
  const taskId =
    events.find((event) => event.runId === run.friendlyId && event.data?.message)?.data?.message ??
    events[0]?.data?.message;

  // Undefined lets the hook fall back to the path.
  if (!taskId) return undefined;

  const signals: AgentPageSignal[] = [];

  if (FAILED_STATUSES.has(run.status)) {
    const failedAtMs = toMillis(run.completedAt);
    if (failedAtMs !== undefined && now - failedAtMs <= FRESH_FAILURE_WINDOW_MS) {
      signals.push({
        kind: "fresh_failure",
        runId: run.friendlyId,
        failedAt: toIso(run.completedAt)!,
      });
    }
  } else if (WAITING_STATUSES.has(run.status)) {
    signals.push({ kind: "waiting_run", runId: run.friendlyId });
  }

  return {
    page: {
      kind: "run",
      runId: run.friendlyId,
      status: STATUS_LABELS[run.status] ?? run.status,
      taskId,
    },
    signals,
  };
}

/** The errors list defers its data, so the page kind is all there is. */
export function errorsAgentPageContext(): AgentPageContext {
  return { page: { kind: "errors" }, signals: [] };
}

const errorLoaderDataSchema = z.object({ fingerprint: z.string().min(1) });

export function errorAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = errorLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  return { page: { kind: "error", fingerprint: parsed.data.fingerprint }, signals: [] };
}

const queuesLoaderDataSchema = z.object({
  environment: z.object({
    running: z.number(),
    queued: z.number(),
    concurrencyLimit: z.number(),
    burstFactor: z.number().nullish(),
  }),
});

/** Saturation matches the page's own "Running" tile (`getEnvConcurrencyLimitStatus`). */
export function queuesAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = queuesLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { running, queued, concurrencyLimit, burstFactor } = parsed.data.environment;
  const limit = concurrencyLimit * (burstFactor && burstFactor > 0 ? burstFactor : 1);
  const signals: AgentPageSignal[] = [];

  if (isQueueAtCapacity({ running, queued, limit })) {
    signals.push({
      kind: "concurrency_saturation",
      severity: queued >= limit ? "crit" : "warn",
      scope: "env",
      limit,
      current: running,
    });
  }

  return { page: { kind: "queues" }, signals };
}

/** Re-export under the mapper's name; the queue pages own the threshold. */
export const QUEUE_OLDEST_WAIT_WARNING_MS = OLDEST_WAIT_WARNING_MS;

const queueLoaderDataSchema = z.object({
  queue: z.object({
    name: z.string(),
    type: z.string(),
    paused: z.boolean().nullish(),
    running: z.number(),
    queued: z.number(),
    concurrencyLimit: z.number().nullish(),
  }),
  environmentConcurrencyLimit: z.number().nullish(),
  /** `loadedAt` is the "now" `oldestQueuedAt` was read at. */
  oldestQueuedAt: z.number().nullish(),
  loadedAt: z.number().nullish(),
  ckBreakdown: z
    .object({
      keys: z.array(z.object({ queued: z.number(), oldestEnqueuedAt: z.number() })).nullish(),
    })
    .nullish(),
});

/** Whole-queue oldest wait, as the page computes it (`wholeQueueOldestWaitMs`). */
function oldestWaitMs(
  keys: { queued: number; oldestEnqueuedAt: number }[],
  oldestQueuedAt: number | null | undefined,
  now: number | null | undefined
): number | null {
  if (now === null || now === undefined) return null;
  const waiting = keys.filter((key) => key.queued > 0);
  if (waiting.length > 0) {
    return waiting.reduce((max, key) => Math.max(max, now - key.oldestEnqueuedAt), 0);
  }
  return oldestQueuedAt === null || oldestQueuedAt === undefined
    ? null
    : Math.max(0, now - oldestQueuedAt);
}

/** Queue health, from the same decision the queues list renders (`queueHealthLabel`). */
export function queueAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = queueLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { name, type, paused, running, queued, concurrencyLimit } = parsed.data.queue;
  const { environmentConcurrencyLimit, oldestQueuedAt, loadedAt, ckBreakdown } = parsed.data;
  const limit = concurrencyLimit ?? environmentConcurrencyLimit ?? null;
  const atCapacity = isQueueAtCapacity({ running, queued, limit });

  const oldestWait = oldestWaitMs(ckBreakdown?.keys ?? [], oldestQueuedAt, loadedAt);
  const waitingTooLong = oldestWait !== null && oldestWait >= QUEUE_OLDEST_WAIT_WARNING_MS;

  const health = atCapacity ? "crit" : paused || queued > 0 || waitingTooLong ? "warn" : "ok";

  const signals: AgentPageSignal[] = [];
  // Nothing to watch on a paused queue: it can neither drain nor grow until it is resumed.
  // The stored name, not the display one: a watch the agent proposes has to validate against it.
  const storedName = storedQueueName({ type, name });

  if (atCapacity && !paused) {
    // A backlog at least as deep as the limit won't clear this cycle.
    signals.push({
      kind: "concurrency_saturation",
      severity: queued >= limit! ? "crit" : "warn",
      scope: "queue",
      queueName: storedName,
      limit: limit!,
      current: running,
    });
  }

  return {
    page: { kind: "queue", name: storedName, health, paused: Boolean(paused) },
    signals,
  };
}

export function deploymentsAgentPageContext(): AgentPageContext {
  return { page: { kind: "deployments" }, signals: [] };
}

const deploymentLoaderDataSchema = z.object({
  deployment: z.object({ version: z.string(), status: z.string() }),
});

/** `status` is the raw `WorkerDeploymentStatus`; the registry decides what earns a chip. */
export function deploymentAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = deploymentLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { version, status } = parsed.data.deployment;
  return { page: { kind: "deployment", version, status }, signals: [] };
}

export type SectionPageKind =
  | "tasks"
  | "apikeys"
  | "envvars"
  | "concurrency"
  | "regions"
  | "settings"
  | "logs"
  | "query";

export function sectionAgentPageContext(kind: SectionPageKind): AgentPageContext {
  return { page: { kind }, signals: [] };
}

/** `activity` and `runList` are deferred, so recent failures aren't readable here. */
const taskLoaderDataSchema = z.object({
  task: z.object({
    slug: z.string().min(1),
    triggerSource: z.string().nullish(),
    queue: z.object({ name: z.string(), paused: z.boolean().nullish() }).nullish(),
  }),
  scheduleList: z
    .object({
      totalCount: z.number(),
      schedules: z.array(z.object({ active: z.boolean().nullish() })).nullish(),
    })
    .nullish(),
});

export function taskAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = taskLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { task, scheduleList } = parsed.data;

  // `totalCount` counts every schedule but the loader carries one page, so `active` under-reports.
  const schedules = scheduleList
    ? {
        total: scheduleList.totalCount,
        active: (scheduleList.schedules ?? []).filter((schedule) => schedule.active === true)
          .length,
      }
    : undefined;

  return {
    page: {
      kind: "task",
      taskId: task.slug,
      ...(task.triggerSource ? { triggerSource: task.triggerSource } : {}),
      ...(task.queue ? { queue: task.queue.name, queuePaused: task.queue.paused === true } : {}),
      ...(schedules ? { schedules } : {}),
    },
    signals: [],
  };
}

const scheduleLoaderDataSchema = z.object({
  schedule: z
    .object({
      friendlyId: z.string().min(1),
      taskIdentifier: z.string().min(1),
      active: z.boolean().nullish(),
      runs: z
        .array(z.object({ friendlyId: z.string(), status: z.string(), finishedAt: dateish }))
        .nullish(),
    })
    .nullable(),
});

/** `schedule` is nullable: a just-deleted schedule renders an empty state, not a 404. */
export function scheduleAgentPageContext(
  data: unknown,
  now: number = Date.now()
): AgentPageContext | undefined {
  const parsed = scheduleLoaderDataSchema.safeParse(data);
  if (!parsed.success || parsed.data.schedule === null) return undefined;

  const { friendlyId, taskIdentifier, active, runs } = parsed.data.schedule;

  const signals: AgentPageSignal[] = [];
  // Only the newest run: an older failure may already have recovered.
  const latest = (runs ?? [])[0];
  if (latest && FAILED_STATUSES.has(latest.status)) {
    const failedAtMs = toMillis(latest.finishedAt);
    if (failedAtMs !== undefined && now - failedAtMs <= FRESH_FAILURE_WINDOW_MS) {
      signals.push({
        kind: "fresh_failure",
        runId: latest.friendlyId,
        failedAt: toIso(latest.finishedAt)!,
      });
    }
  }

  return {
    page: {
      kind: "schedule",
      scheduleId: friendlyId,
      taskId: taskIdentifier,
      ...(active === null || active === undefined ? {} : { active }),
    },
    signals,
  };
}

const FAILED_BATCH_STATUSES = new Set(["PARTIAL_FAILED", "ABORTED"]);

export function isFailedBatchStatus(status: string | undefined): boolean {
  return status !== undefined && FAILED_BATCH_STATUSES.has(status);
}

const batchesLoaderDataSchema = z.object({
  batches: z.array(z.object({ friendlyId: z.string(), status: z.string() })),
  hasFilters: z.boolean().nullish(),
});

/** Only the newest batch earns a chip, and only unfiltered, where newest-first holds. */
export function batchesAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = batchesLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { batches, hasFilters } = parsed.data;
  const latest = hasFilters === true ? undefined : batches[0];

  return {
    page: {
      kind: "batches",
      ...(latest && isFailedBatchStatus(latest.status)
        ? { latestFailedBatchId: latest.friendlyId }
        : {}),
    },
    signals: [],
  };
}

const batchLoaderDataSchema = z.object({
  batch: z.object({
    friendlyId: z.string().min(1),
    status: z.string(),
    failedRunCount: z.number().nullish(),
  }),
});

export function batchAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = batchLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { friendlyId, status, failedRunCount } = parsed.data.batch;
  return {
    page: {
      kind: "batch",
      batchId: friendlyId,
      status,
      ...(typeof failedRunCount === "number" ? { failedRunCount } : {}),
    },
    signals: [],
  };
}

const testLoaderDataSchema = z.object({
  /** Present on the picker; the task page has `task` instead. */
  tasks: z.array(z.unknown()).nullish(),
  task: z.object({ taskIdentifier: z.string().min(1) }).nullish(),
  queue: z.object({ paused: z.boolean().nullish() }).nullish(),
});

export function testAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = testLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { task, queue } = parsed.data;
  return {
    page: {
      kind: "test",
      ...(task ? { taskId: task.taskIdentifier } : {}),
      ...(queue ? { queuePaused: queue.paused === true } : {}),
    },
    signals: [],
  };
}

const alertsLoaderDataSchema = z.object({
  alertChannels: z.array(z.object({ enabled: z.boolean().nullish() })),
});

export function alertsAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = alertsLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const channels = parsed.data.alertChannels;
  return {
    page: {
      kind: "alerts",
      channelCount: channels.length,
      disabledChannelCount: channels.filter((channel) => channel.enabled === false).length,
    },
    signals: [],
  };
}

const waitpointsLoaderDataSchema = z.object({
  tokens: z
    .array(z.object({ status: z.string(), timeoutAt: dateish, completedAfter: dateish }))
    .nullish(),
  /** One token, on the detail page. */
  waitpoint: z.object({ id: z.string().min(1), status: z.string() }).nullish(),
});

/** "Still WAITING past its timeout" is derived here; nothing else computes it. */
export function waitpointsAgentPageContext(
  data: unknown,
  now: number = Date.now()
): AgentPageContext | undefined {
  const parsed = waitpointsLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { tokens, waitpoint } = parsed.data;

  if (waitpoint) {
    return {
      page: { kind: "waitpoints", tokenId: waitpoint.id, status: waitpoint.status },
      signals: [],
    };
  }

  const list = tokens ?? [];
  const overdue = list.filter((token) => {
    if (token.status !== "WAITING") return false;
    const timeoutAt = toMillis(token.timeoutAt ?? token.completedAfter);
    return timeoutAt !== undefined && timeoutAt < now;
  });

  return {
    page: {
      kind: "waitpoints",
      timedOutCount: list.filter((token) => token.status === "TIMED_OUT").length,
      overdueCount: overdue.length,
    },
    signals: [],
  };
}

const bulkActionsLoaderDataSchema = z.object({
  bulkActions: z.array(z.object({ status: z.string() })).nullish(),
  bulkAction: z
    .object({
      friendlyId: z.string().min(1),
      status: z.string(),
      failureCount: z.number().nullish(),
    })
    .nullish(),
});

export function bulkActionsAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = bulkActionsLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { bulkActions, bulkAction } = parsed.data;

  if (bulkAction) {
    return {
      page: {
        kind: "bulkactions",
        bulkActionId: bulkAction.friendlyId,
        status: bulkAction.status,
        ...(typeof bulkAction.failureCount === "number"
          ? { failedRunCount: bulkAction.failureCount }
          : {}),
      },
      signals: [],
    };
  }

  return {
    page: {
      kind: "bulkactions",
      pendingCount: (bulkActions ?? []).filter((action) => action.status === "PENDING").length,
    },
    signals: [],
  };
}

const branchesLoaderDataSchema = z.object({
  limits: z.object({ isAtLimit: z.boolean().nullish() }),
});

export function branchesAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = branchesLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  return {
    page: { kind: "branches", atLimit: parsed.data.limits.isAtLimit === true },
    signals: [],
  };
}

const quotaSchema = z
  .object({
    name: z.string(),
    limit: z.number().nullish(),
    currentUsage: z.number(),
    canExceed: z.boolean().nullish(),
  })
  .nullable();

// Quota map keys grow with plans and entries can be null, so values are parsed one at a time.
const limitsLoaderDataSchema = z.object({ quotas: z.record(z.string(), z.unknown()) });

/** `canExceed` quotas are soft, so being over one is not exhausted. */
export function limitsAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = limitsLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const exhausted: string[] = [];
  for (const value of Object.values(parsed.data.quotas)) {
    const quota = quotaSchema.safeParse(value);
    if (!quota.success || quota.data === null) continue;
    const { name, limit, currentUsage, canExceed } = quota.data;
    if (canExceed === true) continue;
    if (limit === null || limit === undefined || limit <= 0) continue;
    if (currentUsage >= limit) exhausted.push(name);
  }

  return {
    page: { kind: "limits", ...(exhausted.length > 0 ? { exhausted } : {}) },
    signals: [],
  };
}

const dashboardsLoaderDataSchema = z.object({ title: z.string().nullish() });

export function dashboardsAgentPageContext(data: unknown): AgentPageContext {
  const parsed = dashboardsLoaderDataSchema.safeParse(data);
  const title = parsed.success ? parsed.data.title : undefined;
  return { page: { kind: "dashboards", ...(title ? { title } : {}) }, signals: [] };
}

const agentLoaderDataSchema = z.object({ agent: z.object({ slug: z.string().min(1) }) });

/** Everything else on this page (activity, runs, sessions) is deferred. */
export function agentsAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = agentLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  return { page: { kind: "agents", agentId: parsed.data.agent.slug }, signals: [] };
}

export function playgroundAgentPageContext(data: unknown): AgentPageContext {
  const parsed = agentLoaderDataSchema.safeParse(data);
  return {
    page: { kind: "playground", ...(parsed.success ? { agentId: parsed.data.agent.slug } : {}) },
    signals: [],
  };
}

const promptsLoaderDataSchema = z.object({
  prompts: z.array(z.object({ hasOverride: z.boolean().nullish() })).nullish(),
  prompt: z.object({ slug: z.string().min(1) }).nullish(),
  overrideVersion: z.object({ version: z.number() }).nullish(),
});

export function promptsAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = promptsLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { prompts, prompt, overrideVersion } = parsed.data;

  if (prompt) {
    return {
      page: { kind: "prompts", slug: prompt.slug, overridden: Boolean(overrideVersion) },
      signals: [],
    };
  }

  return {
    page: {
      kind: "prompts",
      overriddenCount: (prompts ?? []).filter((entry) => entry.hasOverride === true).length,
    },
    signals: [],
  };
}

const modelsLoaderDataSchema = z.object({
  model: z.object({ modelName: z.string().min(1) }).nullish(),
});

export function modelsAgentPageContext(data: unknown): AgentPageContext {
  const parsed = modelsLoaderDataSchema.safeParse(data);
  const modelId = parsed.success ? parsed.data.model?.modelName : undefined;
  return { page: { kind: "models", ...(modelId ? { modelId } : {}) }, signals: [] };
}

const sessionsLoaderDataSchema = z.object({
  /** `status` is derived by the presenter, not stored. */
  sessions: z.array(z.object({ status: z.string() })).nullish(),
  session: z
    .object({
      friendlyId: z.string().min(1),
      currentRun: z.object({ friendlyId: z.string(), status: z.string() }).nullish(),
    })
    .nullish(),
});

export function sessionsAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = sessionsLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { sessions, session } = parsed.data;

  if (session) {
    return {
      page: {
        kind: "sessions",
        sessionId: session.friendlyId,
        ...(session.currentRun
          ? { runId: session.currentRun.friendlyId, runStatus: session.currentRun.status }
          : {}),
      },
      signals: [],
    };
  }

  return {
    page: {
      kind: "sessions",
      expiredCount: (sessions ?? []).filter((entry) => entry.status === "EXPIRED").length,
    },
    signals: [],
  };
}

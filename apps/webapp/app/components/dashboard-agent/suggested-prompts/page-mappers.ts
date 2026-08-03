/**
 * Route `handle` mappers: loader data in, `AgentPageContext` out.
 *
 * These live here rather than inline in the routes so they can be unit tested as
 * plain functions — a route module drags in the whole page. Each one is a pure
 * function of data the loader ALREADY returns; none of them may cause a query,
 * and a field that isn't in the loader means the signal simply isn't emitted.
 *
 * They read raw route-match data (`useAgentPageContext` passes `match.data`
 * straight through), so dates arrive as ISO strings, not `Date`s — hence the
 * string|Date unions. Everything is `safeParse`d: a shape change downstream
 * degrades to "no context", never a thrown mapper.
 *
 * A signal is emitted ONLY for abnormal state. That's the contract the resolver
 * relies on: if a contextual chip is on screen, something is actually up.
 */
import type { AgentPageContext, AgentPageSignal } from "@internal/dashboard-agent-contracts";
import { z } from "zod";

/**
 * How recently a run must have failed for the failure to be "why the user is
 * here". Older failures still show the run page's defaults.
 */
export const FRESH_FAILURE_WINDOW_MS = 30 * 60_000;

/**
 * Run statuses that mean "this failed". Mirrors the error set the run presenter
 * uses for the root span (`isError`).
 */
const FAILED_STATUSES = new Set([
  "COMPLETED_WITH_ERRORS",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

/** Run statuses that mean "queued or delayed, not executing" (`QUEUED_STATUSES`). */
const WAITING_STATUSES = new Set(["PENDING", "PENDING_VERSION", "WAITING_FOR_DEPLOY", "DELAYED"]);

/**
 * Display labels for run statuses, mirroring `runStatusTitleFromStatus` in
 * `components/runs/v3/TaskRunStatus.tsx`. Duplicated rather than imported so
 * this module stays free of React component imports; the contract stores the
 * status as a plain string, so an unmapped status passes through as-is.
 */
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

// ---------------------------------------------------------------------------
// Run detail page
// ---------------------------------------------------------------------------

/**
 * What the run-detail loader gives us. `run.taskIdentifier` isn't in the payload,
 * so the task id comes off the run's own span in the trace — the same span the
 * page's tree renders, whose `message` is the task identifier.
 */
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
  // The run's own span first; the anchor span is events[0] in practice, but a
  // truncated trace can shift it.
  const taskId =
    events.find((event) => event.runId === run.friendlyId && event.data?.message)?.data?.message ??
    events[0]?.data?.message;

  // No task id means we'd be inventing one to satisfy the contract. Returning
  // undefined lets the hook fall back to the path, which is honest.
  if (!taskId) return undefined;

  const signals: AgentPageSignal[] = [];

  if (FAILED_STATUSES.has(run.status)) {
    const failedAtMs = toMillis(run.completedAt);
    // A failure with no timestamp can't be called fresh, so it isn't.
    if (failedAtMs !== undefined && now - failedAtMs <= FRESH_FAILURE_WINDOW_MS) {
      signals.push({
        kind: "fresh_failure",
        runId: run.friendlyId,
        failedAt: toIso(run.completedAt)!,
      });
    }
  } else if (WAITING_STATUSES.has(run.status)) {
    // The queue name isn't in this loader's payload, so it's omitted rather than
    // fetched.
    signals.push({ kind: "waiting_run", runId: run.friendlyId });
  }

  // No `slow_run`: the loader has this run's duration but no per-task p95
  // baseline, and fetching one would be an added query.

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

// ---------------------------------------------------------------------------
// Errors list + error group
// ---------------------------------------------------------------------------

/**
 * The errors list. Its loader defers the list itself, so the match carries
 * promises rather than error groups — the page kind is all we can say without
 * awaiting, which is enough to swap the generic chips for error ones.
 */
export function errorsAgentPageContext(): AgentPageContext {
  return { page: { kind: "errors" }, signals: [] };
}

const errorLoaderDataSchema = z.object({ fingerprint: z.string().min(1) });

/**
 * One error group. The fingerprint is the only non-deferred field in this
 * loader's payload, so there is no occurrence timestamp to call recent — the
 * page's "is it still happening?" question goes to the agent instead of a
 * signal we'd have to query for.
 */
export function errorAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = errorLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  return { page: { kind: "error", fingerprint: parsed.data.fingerprint }, signals: [] };
}

// ---------------------------------------------------------------------------
// Queues list + queue detail
// ---------------------------------------------------------------------------

const queuesLoaderDataSchema = z.object({
  environment: z.object({
    running: z.number(),
    queued: z.number(),
    concurrencyLimit: z.number(),
    burstFactor: z.number().nullish(),
  }),
});

/**
 * The queues list, with the environment-level concurrency the page's own
 * "Running" tile tints (`getEnvConcurrencyLimitStatus`): at the burst limit
 * with work waiting is saturation. The signal has no queue identity because
 * this one is the environment's, not one queue's.
 */
export function queuesAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = queuesLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { running, queued, concurrencyLimit, burstFactor } = parsed.data.environment;
  const limit = concurrencyLimit * (burstFactor && burstFactor > 0 ? burstFactor : 1);
  const signals: AgentPageSignal[] = [];

  if (limit > 0 && running >= limit && queued > 0) {
    signals.push({ kind: "concurrency_saturation", severity: queued >= limit ? "crit" : "warn" });
  }

  return { page: { kind: "queues" }, signals };
}

/**
 * How long the head of the queue may sit unstarted before the queue counts as
 * degraded. The queue detail route imports this as its `OLDEST_WAIT_WARNING_MS`,
 * so the page's warning tint and the health we report here are one threshold.
 */
export const QUEUE_OLDEST_WAIT_WARNING_MS = 5 * 60_000;

const queueLoaderDataSchema = z.object({
  queue: z.object({
    name: z.string(),
    paused: z.boolean().nullish(),
    running: z.number(),
    queued: z.number(),
    concurrencyLimit: z.number().nullish(),
  }),
  environmentConcurrencyLimit: z.number().nullish(),
  /** Enqueue time of the oldest run still waiting, and the "now" it was read at. */
  oldestQueuedAt: z.number().nullish(),
  loadedAt: z.number().nullish(),
  ckBreakdown: z
    .object({
      keys: z.array(z.object({ queued: z.number(), oldestEnqueuedAt: z.number() })).nullish(),
    })
    .nullish(),
});

/**
 * Whole-queue oldest wait, as the page computes it (`wholeQueueOldestWaitMs`):
 * for keyed queues the oldest wait is the worst across keys with a live
 * backlog, otherwise the queue's own oldest message. Null when nothing waits.
 */
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

/**
 * Queue health, from the same running/queued/limit decision the queues list
 * renders as a badge (`queueHealthLabel`): at capacity with work waiting is
 * critical, a backlog under the limit is a warning, paused is a warning. A
 * head-of-line run waiting past the page's own threshold is a warning too —
 * the same state that puts the page's Investigate button on screen.
 */
export function queueAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = queueLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { name, paused, running, queued, concurrencyLimit } = parsed.data.queue;
  const { environmentConcurrencyLimit, oldestQueuedAt, loadedAt, ckBreakdown } = parsed.data;
  const limit = concurrencyLimit ?? environmentConcurrencyLimit ?? null;
  const atCapacity = limit !== null && limit > 0 && running >= limit && queued > 0;

  const oldestWait = oldestWaitMs(ckBreakdown?.keys ?? [], oldestQueuedAt, loadedAt);
  const waitingTooLong = oldestWait !== null && oldestWait >= QUEUE_OLDEST_WAIT_WARNING_MS;

  const health = atCapacity ? "crit" : paused || queued > 0 || waitingTooLong ? "warn" : "ok";

  const signals: AgentPageSignal[] = [];
  if (atCapacity) {
    // A backlog at least as deep as the limit is a queue that won't clear this
    // cycle — that's the crit case.
    signals.push({ kind: "concurrency_saturation", severity: queued >= limit! ? "crit" : "warn" });
  }

  // No `waiting_run` for a stalled head of line: the loader has the wait time
  // but not the run's id, and the signal is about a named run. The `warn`
  // health carries it instead, which is what the page's Investigate button
  // gates on.

  return { page: { kind: "queue", name, health }, signals };
}

// ---------------------------------------------------------------------------
// Deployments list + deployment detail
// ---------------------------------------------------------------------------

/**
 * The deployments list. Nothing here is abnormal on its own — a failed deploy
 * in the table is history, not news — so the page kind carries the chips.
 */
export function deploymentsAgentPageContext(): AgentPageContext {
  return { page: { kind: "deployments" }, signals: [] };
}

const deploymentLoaderDataSchema = z.object({
  deployment: z.object({ version: z.string(), status: z.string() }),
});

/**
 * One deployment. The status is the raw `WorkerDeploymentStatus`; the registry
 * decides which of them is worth an investigate chip. No signal: the signal
 * vocabulary is about runs and concurrency, and a failed deploy is neither.
 */
export function deploymentAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = deploymentLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { version, status } = parsed.data.deployment;
  return { page: { kind: "deployment", version, status }, signals: [] };
}

// ---------------------------------------------------------------------------
// Sections whose loader has nothing abnormal to report
// ---------------------------------------------------------------------------

/**
 * Page kinds that need no loader data at all: the page kind is the whole story,
 * and everything that could be called abnormal on them is either behind a
 * deferred promise (the logs explorer, the tasks list's activity) or simply not
 * a health question (the query editor, the API keys page).
 *
 * One function rather than eight one-liners: the route reads
 * `sectionAgentPageContext("regions")`, which says the same thing a
 * `regionsAgentPageContext()` wrapper would.
 */
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

// ---------------------------------------------------------------------------
// Task detail (standard + scheduled)
// ---------------------------------------------------------------------------

/**
 * The task-detail loaders. `task` and (on the scheduled variant) `scheduleList`
 * resolve synchronously; `activity` and `runList` are deferred, so recent
 * failures are deliberately not read here.
 */
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

/**
 * One task. A paused queue and a scheduled task with no enabled schedule are
 * both "this will never run", and both are in the loader already — the registry
 * turns them into the investigate chip. No signal: the vocabulary is about runs
 * and concurrency, and neither of these is a run.
 */
export function taskAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = taskLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { task, scheduleList } = parsed.data;

  // `totalCount` counts every schedule on the task; the page only lists one
  // page of them, so `active` is counted off what we were given and can only
  // under-report. That's the safe direction: it never claims "none are active".
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

// ---------------------------------------------------------------------------
// Schedule detail
// ---------------------------------------------------------------------------

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

/**
 * One schedule. The loader carries the schedule's last few runs, so unlike the
 * other section pages this one CAN emit `fresh_failure` — the newest run failing
 * a few minutes ago is exactly why someone opens the panel here. Older failures
 * fall back to the page's own chips.
 *
 * `schedule` is nullable in the loader (a just-deleted schedule renders an empty
 * state rather than a 404), and a null one has no identity to report.
 */
export function scheduleAgentPageContext(
  data: unknown,
  now: number = Date.now()
): AgentPageContext | undefined {
  const parsed = scheduleLoaderDataSchema.safeParse(data);
  if (!parsed.success || parsed.data.schedule === null) return undefined;

  const { friendlyId, taskIdentifier, active, runs } = parsed.data.schedule;

  const signals: AgentPageSignal[] = [];
  // Only the newest run: an older failure the schedule has since recovered from
  // isn't news.
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

// ---------------------------------------------------------------------------
// Batches list + batch detail
// ---------------------------------------------------------------------------

/** `BatchTaskRunStatus` values that mean "this batch didn't come out clean". */
const FAILED_BATCH_STATUSES = new Set(["PARTIAL_FAILED", "ABORTED"]);

/** Whether a batch status is one the agent can investigate. */
export function isFailedBatchStatus(status: string | undefined): boolean {
  return status !== undefined && FAILED_BATCH_STATUSES.has(status);
}

const batchesLoaderDataSchema = z.object({
  batches: z.array(z.object({ friendlyId: z.string(), status: z.string() })),
  hasFilters: z.boolean().nullish(),
});

/**
 * The batches list, newest first. Only the NEWEST batch is worth a chip, and
 * only on an unfiltered list: "your latest batch partly failed" is news, while
 * a failure further down the table is history — the same line the deployments
 * list draws. A filtered list isn't in newest-first order of anything the user
 * asked about, so it says nothing.
 */
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

/**
 * One batch. `failedRunCount` is live for a batch still processing, so the
 * registry can name the number in the chip.
 */
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

// ---------------------------------------------------------------------------
// Test page (task picker + one task)
// ---------------------------------------------------------------------------

const testLoaderDataSchema = z.object({
  /** Present on the picker; the task page has `task` instead. */
  tasks: z.array(z.unknown()).nullish(),
  task: z.object({ taskIdentifier: z.string().min(1) }).nullish(),
  queue: z.object({ paused: z.boolean().nullish() }).nullish(),
});

/**
 * The test page, for both the picker and one task. A paused queue means the
 * test run the user is about to send won't execute, which is the one thing here
 * worth interrupting them about.
 */
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

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const alertsLoaderDataSchema = z.object({
  alertChannels: z.array(z.object({ enabled: z.boolean().nullish() })),
});

/**
 * The alerts page. A switched-off channel is the page's one abnormal state the
 * loader actually knows about — delivery failures live on `ProjectAlert`, which
 * this loader never reads, so "this alert failed to send" is not something we
 * can claim.
 */
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

// ---------------------------------------------------------------------------
// Waitpoint tokens (list + one token)
// ---------------------------------------------------------------------------

const waitpointsLoaderDataSchema = z.object({
  /** The list. Both the success and failure variants of the presenter carry it. */
  tokens: z
    .array(z.object({ status: z.string(), timeoutAt: dateish, completedAfter: dateish }))
    .nullish(),
  /** One token, on the detail page. */
  waitpoint: z.object({ id: z.string().min(1), status: z.string() }).nullish(),
});

/**
 * Waitpoint tokens. Two states are worth a chip and both are in the loader: a
 * token that timed out, and a token still `WAITING` past its own timeout — the
 * second one nothing computes for us, so it's computed here from the timeout the
 * list already carries.
 */
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

// ---------------------------------------------------------------------------
// Bulk actions (list + one action)
// ---------------------------------------------------------------------------

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

/**
 * Bulk actions. The detail page knows how many runs the action failed on, which
 * is the whole question a user has after running a replay.
 */
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

// ---------------------------------------------------------------------------
// Branches (preview + dev)
// ---------------------------------------------------------------------------

const branchesLoaderDataSchema = z.object({
  limits: z.object({ isAtLimit: z.boolean().nullish() }),
});

/**
 * The branch list. At the limit the page can't create another branch, which is
 * the question the user came with.
 */
export function branchesAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = branchesLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  return {
    page: { kind: "branches", atLimit: parsed.data.limits.isAtLimit === true },
    signals: [],
  };
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const quotaSchema = z
  .object({
    name: z.string(),
    limit: z.number().nullish(),
    currentUsage: z.number(),
    canExceed: z.boolean().nullish(),
  })
  .nullable();

// The quota map's keys grow as plans grow, and several entries are `null`, so
// the values are parsed one at a time rather than typed up front.
const limitsLoaderDataSchema = z.object({ quotas: z.record(z.string(), z.unknown()) });

/**
 * The limits page. A quota at or over its limit is a wall the user is already
 * standing at, so the names of those quotas go on the page — the chip can then
 * name the one they hit rather than asking "which limits am I near?".
 *
 * `canExceed` quotas are excluded: those are soft and being over them is normal.
 */
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

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

const dashboardsLoaderDataSchema = z.object({ title: z.string().nullish() });

/**
 * A metrics dashboard, or the chooser. The title is the only thing that
 * distinguishes one dashboard from another to a user, so it rides along and the
 * chooser (which has no title) reports the section on its own.
 */
export function dashboardsAgentPageContext(data: unknown): AgentPageContext {
  const parsed = dashboardsLoaderDataSchema.safeParse(data);
  const title = parsed.success ? parsed.data.title : undefined;
  return { page: { kind: "dashboards", ...(title ? { title } : {}) }, signals: [] };
}

// ---------------------------------------------------------------------------
// Agents + playground
// ---------------------------------------------------------------------------

const agentLoaderDataSchema = z.object({ agent: z.object({ slug: z.string().min(1) }) });

/** One agent. Everything else on this page (activity, runs, sessions) is deferred. */
export function agentsAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = agentLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  return { page: { kind: "agents", agentId: parsed.data.agent.slug }, signals: [] };
}

/**
 * The playground, for both the agent picker and one agent. The picker's loader
 * has no agent to name, so it reports the section alone.
 */
export function playgroundAgentPageContext(data: unknown): AgentPageContext {
  const parsed = agentLoaderDataSchema.safeParse(data);
  return {
    page: { kind: "playground", ...(parsed.success ? { agentId: parsed.data.agent.slug } : {}) },
    signals: [],
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const promptsLoaderDataSchema = z.object({
  /** The list. */
  prompts: z.array(z.object({ hasOverride: z.boolean().nullish() })).nullish(),
  /** One prompt. */
  prompt: z.object({ slug: z.string().min(1) }).nullish(),
  overrideVersion: z.object({ version: z.number() }).nullish(),
});

/**
 * Prompts. An active override is the abnormal state that matters here: runs
 * silently use the pinned version instead of the current one, and nothing else
 * on the page says so loudly.
 */
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

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const modelsLoaderDataSchema = z.object({
  model: z.object({ modelName: z.string().min(1) }).nullish(),
});

/**
 * The model registry, or one model. Nothing here is abnormal — a model's cost
 * and latency are questions, not alarms — so the identity is the whole context.
 */
export function modelsAgentPageContext(data: unknown): AgentPageContext {
  const parsed = modelsLoaderDataSchema.safeParse(data);
  const modelId = parsed.success ? parsed.data.model?.modelName : undefined;
  return { page: { kind: "models", ...(modelId ? { modelId } : {}) }, signals: [] };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const sessionsLoaderDataSchema = z.object({
  /** The list. `status` is derived by the presenter, not stored. */
  sessions: z.array(z.object({ status: z.string() })).nullish(),
  /** One session. */
  session: z
    .object({
      friendlyId: z.string().min(1),
      currentRun: z.object({ friendlyId: z.string(), status: z.string() }).nullish(),
    })
    .nullish(),
});

/**
 * Agent sessions. The detail page carries the session's current run and how it
 * ended, so a failed run there earns the investigate chip — and unlike the
 * schedule page there's no timestamp on it, so it's a page fact rather than a
 * `fresh_failure` we'd have to date.
 */
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

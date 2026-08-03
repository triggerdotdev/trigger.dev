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

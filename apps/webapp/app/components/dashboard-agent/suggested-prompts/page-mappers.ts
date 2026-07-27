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
// Queue detail page
// ---------------------------------------------------------------------------

const queueLoaderDataSchema = z.object({
  queue: z.object({
    name: z.string(),
    paused: z.boolean().nullish(),
    running: z.number(),
    queued: z.number(),
    concurrencyLimit: z.number().nullish(),
  }),
});

/**
 * Queue health, from the same running/queued/limit decision the queues list
 * renders as a badge (`queueHealthLabel`): at capacity with work waiting is
 * critical, a backlog under the limit is a warning, paused is a warning.
 */
export function queueAgentPageContext(data: unknown): AgentPageContext | undefined {
  const parsed = queueLoaderDataSchema.safeParse(data);
  if (!parsed.success) return undefined;

  const { name, paused, running, queued, concurrencyLimit } = parsed.data.queue;
  const limit = concurrencyLimit ?? null;
  const atCapacity = limit !== null && limit > 0 && running >= limit && queued > 0;

  const health = atCapacity ? "crit" : paused || queued > 0 ? "warn" : "ok";

  const signals: AgentPageSignal[] = [];
  if (atCapacity) {
    // A backlog at least as deep as the limit is a queue that won't clear this
    // cycle — that's the crit case.
    signals.push({ kind: "concurrency_saturation", severity: queued >= limit! ? "crit" : "warn" });
  }

  return { page: { kind: "queue", name, health }, signals };
}

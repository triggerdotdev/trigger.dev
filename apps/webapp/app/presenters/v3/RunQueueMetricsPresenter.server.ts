import { boundedIn } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { env } from "~/env.server";
import { engine } from "~/v3/runEngine.server";

export type RunQueueWaiting = {
  queued: number;
  running: number;
  concurrencyLimit: number | null;
  delayP50Ms: number | null;
  delayP95Ms: number | null;
  loadedAt: number;
  ids: { organizationId: string; projectId: string; environmentId: string };
  /** Environment-wide concurrency: a run can wait on this even when its queue has room. The
   * limit includes the burst factor, which is what the queue enforces. */
  env: { running: number; limit: number; baseLimit: number };
  /** The queue's cap across every concurrency key, when it has one. */
  total: { running: number; limit: number } | null;
  concurrencyKey: {
    key: string;
    queued: number;
    running: number;
    oldestWaitMs: number | null;
    /** A temporary per-key limit replacing the queue's perKey for this key. */
    limitOverride: number | null;
  } | null;
  /** The named concurrency limits the run must also hold a slot in (its gates). */
  limits: RunNamedLimitWaiting[];
};

/** One named concurrency limit (`concurrency: { limits: [...] }`) along the run's path. */
type RunNamedLimitWaiting = {
  /** The limit's name as the SDK declared it (no internal prefix). */
  name: string;
  paused: boolean;
  queued: number;
  /** The run's key pool under the limit (or the keyless pool), when the limit has a perKey. */
  perKey: { key: string | null; running: number; limit: number } | null;
  /** The limit's cap across every key, when it has one. */
  total: { running: number; limit: number } | null;
};

const LIMIT_QUEUE_PREFIX = "limit/";
// A run holds at most a few limits; this bounds the reads if a row says otherwise.
const MAX_GATES_READ = 8;

/** Gates as stored on TaskRun: [{ queue, concurrencyKey? }]. Anything else reads as none. */
function parseRunGates(gates: unknown): Array<{ queue: string; concurrencyKey?: string }> {
  if (!Array.isArray(gates)) return [];
  return gates
    .filter(
      (g): g is { queue: string; concurrencyKey?: unknown } =>
        typeof g === "object" && g !== null && typeof (g as { queue?: unknown }).queue === "string"
    )
    .slice(0, MAX_GATES_READ)
    .map((g) => ({
      queue: g.queue,
      concurrencyKey:
        typeof g.concurrencyKey === "string" && g.concurrencyKey !== ""
          ? g.concurrencyKey
          : undefined,
    }));
}

export type RunQueueMetrics = {
  queueFriendlyId: string | null;
  queueName: string;
  paused: boolean;
  waiting: RunQueueWaiting | null;
};

// PENDING renders as "Queued" in the dashboard.
const WAITING_STATUSES = new Set(["PENDING", "DELAYED", "PENDING_VERSION"]);

const DELAY_WINDOW_MS = 60 * 60 * 1000;
// Window bounds snap to this grid so repeated span opens share ClickHouse cache entries.
const DELAY_GRID_MS = 5 * 60 * 1000;

/**
 * Queue context for the run inspector: the queue's friendlyId for linking plus, for runs
 * waiting to start, live counts and recent delay percentiles. Null when flag off.
 */
export async function resolveRunQueueMetrics(options: {
  request: Request;
  userId: string;
  organizationSlug: string;
  projectParam: string;
  envParam: string;
  run: {
    environmentId: string;
    status: string;
    engine: string;
    queue: { name: string; concurrencyKey?: string | null };
    /** TaskRun.gates: the named limits the run also holds. */
    gates?: unknown;
  };
  /**
   * The delay percentiles a caller already has. They're computed on a 5-minute grid over the
   * last hour, so a poll passes back what the first load returned instead of asking again.
   */
  knownDelays?: { p50: number | null; p95: number | null };
}): Promise<RunQueueMetrics | null> {
  const { request, userId, organizationSlug, projectParam, envParam, run, knownDelays } = options;

  try {
    if (!(await canAccessQueueMetricsUi({ request, userId, organizationSlug }))) {
      return null;
    }

    const taskQueue = await $replica.taskQueue.findFirst({
      where: { runtimeEnvironmentId: run.environmentId, name: run.queue.name },
      select: { friendlyId: true, concurrencyLimit: true, paused: true },
    });

    const base: RunQueueMetrics = {
      queueFriendlyId: taskQueue?.friendlyId ?? null,
      queueName: run.queue.name,
      paused: taskQueue?.paused ?? false,
      waiting: null,
    };

    // Live reads go to the Run Engine 2.0 run-queue, so V1 runs get the link only.
    if (run.engine !== "V2" || !WAITING_STATUSES.has(run.status)) {
      return base;
    }

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    if (!project) return base;
    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) return base;

    const queueName = run.queue.name;
    const ck = run.queue.concurrencyKey ?? undefined;

    const [
      queued,
      envRunning,
      envLimit,
      concurrency,
      totalRunning,
      totalLimits,
      ckQueued,
      ckRunning,
      ckOldest,
      ckLimit,
      delays,
    ] = await Promise.all([
      engine.lengthOfQueue(environment, queueName),
      engine.concurrencyOfEnvQueue(environment),
      engine.getEnvConcurrencyLimitWithBurstFactor(environment),
      engine.currentConcurrencyOfQueues(environment, [queueName]),
      engine.totalConcurrencyOfQueues(environment, [queueName]),
      engine.totalConcurrencyLimitsOfQueues(environment, [queueName]),
      ck ? engine.lengthOfQueue(environment, queueName, ck) : null,
      ck ? engine.currentConcurrencyOfQueue(environment, queueName, ck) : null,
      ck ? engine.oldestMessageInQueue(environment, queueName, ck) : undefined,
      ck ? engine.getQueueConcurrencyKeyLimit(environment, queueName, ck) : undefined,
      knownDelays ??
        delaySummary({
          organizationId: project.organizationId,
          projectId: project.id,
          environmentId: environment.id,
          queueName,
        }),
    ]);
    const limits = await namedLimitsWaiting(environment, parseRunGates(run.gates), ck);

    const loadedAt = Date.now();

    return {
      ...base,
      waiting: {
        queued,
        running: concurrency?.[queueName] ?? 0,
        concurrencyLimit: taskQueue?.concurrencyLimit ?? null,
        delayP50Ms: delays.p50,
        delayP95Ms: delays.p95,
        loadedAt,
        ids: {
          organizationId: project.organizationId,
          projectId: project.id,
          environmentId: environment.id,
        },
        env: {
          running: envRunning,
          limit: envLimit,
          baseLimit: environment.maximumConcurrencyLimit,
        },
        // The stored total is clamped to the environment's limit when enforced.
        total:
          totalLimits[queueName] !== undefined
            ? {
                running: totalRunning[queueName] ?? 0,
                limit: Math.min(totalLimits[queueName]!, environment.maximumConcurrencyLimit),
              }
            : null,
        concurrencyKey: ck
          ? {
              key: ck,
              queued: ckQueued ?? 0,
              running: ckRunning ?? 0,
              oldestWaitMs: typeof ckOldest === "number" ? Math.max(0, loadedAt - ckOldest) : null,
              limitOverride: ckLimit?.concurrency ?? null,
            }
          : null,
        limits,
      },
    };
  } catch (error) {
    logger.warn("resolveRunQueueMetrics failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Live state of each named limit the run holds, read the way the engine admits: the gate's own
 * key, else the run's key, picks the per-key pool; perKey and total are clamped to the
 * environment's base limit. One TaskQueue read plus a few run-queue reads per limit.
 */
async function namedLimitsWaiting(
  environment: NonNullable<Awaited<ReturnType<typeof findEnvironmentBySlug>>>,
  gates: Array<{ queue: string; concurrencyKey?: string }>,
  runKey: string | undefined
): Promise<RunNamedLimitWaiting[]> {
  // With gates off the engine admits runs without them, so a limit can't be what holds one.
  if (gates.length === 0 || env.RUN_ENGINE_QUEUE_GATES_ENABLED !== "1") return [];
  try {
    const names = gates.map((g) => g.queue);
    const [rows, totalRunning, queued] = await Promise.all([
      $replica.taskQueue.findMany({
        where: { runtimeEnvironmentId: environment.id, name: { in: boundedIn(names) } },
        select: {
          name: true,
          paused: true,
          concurrencyLimit: true,
          totalConcurrencyLimit: true,
        },
      }),
      engine.totalConcurrencyOfQueues(environment, names),
      engine.gateQueuedCountOfQueues(environment, names),
    ]);
    const envBase = environment.maximumConcurrencyLimit;

    return await Promise.all(
      gates.flatMap((gate) => {
        const row = rows.find((r) => r.name === gate.queue);
        if (!row) return [];
        const key = gate.concurrencyKey ?? runKey ?? null;
        return [
          (async (): Promise<RunNamedLimitWaiting> => {
            const [keyRunning, keyOverride] = await Promise.all([
              row.concurrencyLimit !== null
                ? engine.currentConcurrencyOfQueue(environment, row.name, key ?? undefined)
                : null,
              row.concurrencyLimit !== null && key
                ? engine.getQueueConcurrencyKeyLimit(environment, row.name, key)
                : undefined,
            ]);
            const perKeyLimit =
              row.concurrencyLimit !== null
                ? Math.min(keyOverride?.concurrency ?? row.concurrencyLimit, envBase)
                : null;
            return {
              name: row.name.startsWith(LIMIT_QUEUE_PREFIX)
                ? row.name.slice(LIMIT_QUEUE_PREFIX.length)
                : row.name,
              paused: row.paused,
              queued: queued[row.name] ?? 0,
              perKey:
                perKeyLimit !== null ? { key, running: keyRunning ?? 0, limit: perKeyLimit } : null,
              total:
                row.totalConcurrencyLimit !== null
                  ? {
                      running: totalRunning[row.name] ?? 0,
                      limit: Math.min(row.totalConcurrencyLimit, envBase),
                    }
                  : null,
            };
          })(),
        ];
      })
    );
  } catch (error) {
    logger.warn("namedLimitsWaiting failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function formatClickhouseDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function delaySummary(input: {
  organizationId: string;
  projectId: string;
  environmentId: string;
  queueName: string;
}): Promise<{ p50: number | null; p95: number | null }> {
  try {
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      input.organizationId,
      "queueMetrics"
    );

    const endMs = Math.ceil(Date.now() / DELAY_GRID_MS) * DELAY_GRID_MS;
    const startMs = endMs - DELAY_WINDOW_MS;

    const [error, rows] = await clickhouse.queueMetrics.listSummary({
      organizationId: input.organizationId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      queueNames: [input.queueName],
      startTime: formatClickhouseDateTime(new Date(startMs)),
      endTime: formatClickhouseDateTime(new Date(endMs)),
    });

    if (error) return { p50: null, p95: null };
    const row = rows?.[0];
    if (!row) return { p50: null, p95: null };

    return {
      p50: Number.isFinite(row.p50_wait_ms) ? row.p50_wait_ms : null,
      p95: Number.isFinite(row.p95_wait_ms) ? row.p95_wait_ms : null,
    };
  } catch {
    return { p50: null, p95: null };
  }
}

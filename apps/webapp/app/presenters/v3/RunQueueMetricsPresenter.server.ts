import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { logger } from "~/services/logger.server";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { engine } from "~/v3/runEngine.server";

export type RunQueueWaiting = {
  queued: number;
  running: number;
  concurrencyLimit: number | null;
  delayP50Ms: number | null;
  delayP95Ms: number | null;
  loadedAt: number;
  ids: { organizationId: string; projectId: string; environmentId: string };
  concurrencyKey: {
    key: string;
    queued: number;
    running: number;
    oldestWaitMs: number | null;
  } | null;
};

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
  };
}): Promise<RunQueueMetrics | null> {
  const { request, userId, organizationSlug, projectParam, envParam, run } = options;

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

    const [queued, concurrency, ckQueued, ckRunning, ckOldest, delays] = await Promise.all([
      engine.lengthOfQueue(environment, queueName),
      engine.currentConcurrencyOfQueues(environment, [queueName]),
      ck ? engine.lengthOfQueue(environment, queueName, ck) : null,
      ck ? engine.currentConcurrencyOfQueue(environment, queueName, ck) : null,
      ck ? engine.oldestMessageInQueue(environment, queueName, ck) : undefined,
      delaySummary({
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        queueName,
      }),
    ]);

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
        concurrencyKey: ck
          ? {
              key: ck,
              queued: ckQueued ?? 0,
              running: ckRunning ?? 0,
              oldestWaitMs: typeof ckOldest === "number" ? Math.max(0, loadedAt - ckOldest) : null,
            }
          : null,
      },
    };
  } catch (error) {
    logger.warn("resolveRunQueueMetrics failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
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

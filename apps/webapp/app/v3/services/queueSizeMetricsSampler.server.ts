import type { ClickHouse, MetricsV1Input } from "@internal/clickhouse";
import type { RunEngine } from "@internal/run-engine";
import { Prisma, type PrismaClient, type RuntimeEnvironmentType } from "@trigger.dev/database";
import type { RedisClient } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { getQueueSizeLimit } from "~/v3/utils/queueLimits.server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const QUEUE_SIZE_METRICS_LOCK_KEY = "metrics:queue-size:sampler";
const LENGTH_READ_CONCURRENCY = 100;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return results;
}

export type QueueSizeMetricsSamplerOptions = {
  intervalSec: number;
  maxEnvs: number;
};

export type QueueSizeMetricsSamplerDeps = {
  /** Read-only; pass a replica. */
  replica: Pick<PrismaClient, "$queryRaw">;
  redis: Pick<RedisClient, "set" | "eval">;
  clickhouse: Pick<ClickHouse, "reader">;
  lengthOfEnvQueue: RunEngine["lengthOfEnvQueue"];
  /** Writes the rows and resolves to how many were written. */
  insert: (rows: MetricsV1Input[]) => Promise<number>;
};

type QueueSizeMetricsSampleResult =
  | { status: "locked" }
  | { status: "sampled"; environments: number; rows: number };

type ActiveEnvironment = {
  id: string;
  type: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
  maximumDevQueueSize: number | null;
  maximumDeployedQueueSize: number | null;
};

export function queueSizeMetricsCron(intervalSec: number): string {
  return `*/${intervalSec} * * * * *`;
}

export function slotFor(at: Date, intervalSec: number): number {
  return Math.floor(at.getTime() / 1000 / intervalSec);
}

export function rowsFor(
  environment: Pick<ActiveEnvironment, "id" | "projectId" | "organizationId">,
  queued: number,
  limit: number | null,
  bucketStart: string
): MetricsV1Input[] {
  const base = {
    organization_id: environment.organizationId,
    project_id: environment.projectId,
    environment_id: environment.id,
    metric_type: "gauge",
    metric_subject: "",
    bucket_start: bucketStart,
    attributes: {},
  };
  return [
    { ...base, metric_name: "queue.size.queued", value: queued },
    ...(limit === null ? [] : [{ ...base, metric_name: "queue.size.limit", value: limit }]),
  ];
}

/** Alert-bound environments first, then recently active ones, deduped and capped. */
export function pickEnvironments(alertBound: string[], discovered: string[], cap: number) {
  return Array.from(new Set([...alertBound, ...discovered])).slice(0, cap);
}

/** Inserts rows grouped by the ClickHouse client that owns each organization. */
export function insertByOrganization(
  resolveClient: (organizationId: string) => Pick<ClickHouse, "metrics">
): (rows: MetricsV1Input[]) => Promise<number> {
  return async (rows) => {
    const groups = new Map<Pick<ClickHouse, "metrics">, MetricsV1Input[]>();
    for (const row of rows) {
      const client = resolveClient(row.organization_id);
      groups
        .set(client, groups.get(client) ?? [])
        .get(client)!
        .push(row);
    }
    const written = await Promise.all(
      Array.from(groups, async ([client, group]) => {
        try {
          const [error] = await client.metrics.insert(group);
          if (error) throw error;
          return group.length;
        } catch (error) {
          logger.error("queue size metrics: clickhouse insert failed", {
            rows: group.length,
            error: error instanceof Error ? error.message : String(error),
          });
          return 0;
        }
      })
    );
    return written.reduce((total, count) => total + count, 0);
  };
}

export async function runTick(
  params: { now: Date; scheduledAt?: Date },
  options: QueueSizeMetricsSamplerOptions,
  deps: QueueSizeMetricsSamplerDeps
): Promise<QueueSizeMetricsSampleResult> {
  const lockKey = `${QUEUE_SIZE_METRICS_LOCK_KEY}:${slotFor(
    params.scheduledAt ?? params.now,
    options.intervalSec
  )}`;
  const token = randomUUID();
  const acquired = await deps.redis.set(lockKey, token, "EX", options.intervalSec * 2, "NX");
  if (acquired !== "OK") {
    return { status: "locked" };
  }

  try {
    return await sampleSlot(params.now, options, deps);
  } catch (error) {
    await deps.redis.eval(RELEASE_OWN_LOCK, 1, lockKey, token);
    throw error;
  }
}

/** Deletes the lock only while it still holds our token, so an expired lock taken over stays. */
const RELEASE_OWN_LOCK = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0`;

async function sampleSlot(
  now: Date,
  options: QueueSizeMetricsSamplerOptions,
  deps: QueueSizeMetricsSamplerDeps
): Promise<QueueSizeMetricsSampleResult> {
  const alertBound = await deps.replica.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT DISTINCT "environmentId" AS id FROM "Alert"
    WHERE "lifecycle" = 'active'
      AND "capabilityKey" LIKE 'limits.queue%'
  `);

  const [discoveryError, recentlyActive] = await deps.clickhouse.reader.query({
    name: "queueSizeMetricsActiveEnvironments",
    query: `
      SELECT environment_id, max(bucket_start) AS last
      FROM trigger_dev.env_metrics_v1
      WHERE bucket_start >= now() - INTERVAL 24 HOUR
      GROUP BY environment_id
      ORDER BY last DESC
      LIMIT {limit: UInt32}
    `,
    params: z.object({ limit: z.number() }),
    schema: z.object({ environment_id: z.string() }),
  })({ limit: options.maxEnvs + 1 });
  if (discoveryError) {
    throw discoveryError;
  }

  const environmentIds = pickEnvironments(
    alertBound.map((env) => env.id),
    recentlyActive.map((env) => env.environment_id),
    options.maxEnvs + 1
  );
  if (environmentIds.length > options.maxEnvs) {
    logger.warn("queue size metrics: active environments capped", { maxEnvs: options.maxEnvs });
  }

  const environments = await deps.replica.$queryRaw<ActiveEnvironment[]>(Prisma.sql`
    SELECT e."id", e."type", e."projectId", e."organizationId",
      o."maximumDevQueueSize", o."maximumDeployedQueueSize"
    FROM "RuntimeEnvironment" e
    JOIN "Organization" o ON o."id" = e."organizationId"
    WHERE e."id" = ANY(${environmentIds.slice(0, options.maxEnvs)}::text[])
      AND e."archivedAt" IS NULL
      AND o."deletedAt" IS NULL
  `);

  const bucketStart = new Date(Math.floor(now.getTime() / 10_000) * 10_000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");

  let failed = 0;
  const rows = (
    await mapLimit(environments, LENGTH_READ_CONCURRENCY, async (environment) => {
      try {
        const queued = await deps.lengthOfEnvQueue({
          id: environment.id,
          type: environment.type,
          maximumConcurrencyLimit: 0,
          concurrencyLimitBurstFactor: 1,
          project: { id: environment.projectId },
          organization: { id: environment.organizationId },
        });
        return rowsFor(
          environment,
          queued,
          getQueueSizeLimit(environment.type, environment),
          bucketStart
        );
      } catch {
        failed++;
        return [];
      }
    })
  ).flat();
  if (failed > 0) {
    logger.warn("queue size metrics: queue length reads failed", { failed });
  }

  return {
    status: "sampled",
    environments: environments.length,
    rows: await deps.insert(rows),
  };
}

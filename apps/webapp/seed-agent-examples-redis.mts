/**
 * The run-queue Redis keys the seeder and the scenario kit both stage.
 *
 * The health report and the queue pages prefer the live Redis depth over the
 * metric series, and a queue watch checks the PER-QUEUE key (`lengthOfQueue`) —
 * so a scenario that only moves the env-level key leaves every queue reading 0
 * and a drain watch one-shots with "that already happened". Both keys live here
 * so there is one definition of their shape.
 *
 * Local only: staging refuses a non-local Redis host.
 */

/** Members are staged in batches this size, so a 5k depth is a handful of ZADDs. */
const ZADD_BATCH = 1_000;

/**
 * Default cap on the members a per-queue key gets. The seeder stages the whole
 * env depth on the env key but only a batch of it per queue — the story's numbers
 * come from the metric series, and the key only has to be non-empty. The scenario
 * kit passes the exact depth instead, because a threshold watch reads it.
 */
export const DEFAULT_QUEUE_MEMBER_CAP = 1_000;

export function redisConnection(): { host: string; port: number } | null {
  const host = process.env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? process.env.REDIS_HOST ?? "localhost";
  const port = Number(
    process.env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379
  );
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(host)) {
    console.warn(`Skipping Redis staging on a non-local host: ${host}`);
    return null;
  }
  return { host, port };
}

export function envQueueKey(organizationId: string, environmentId: string): string {
  return `engine:runqueue:{org:${organizationId}}:env:${environmentId}`;
}

/**
 * The PER-QUEUE counter (`engine.lengthOfQueue`) — what a queue watch checks and
 * the queue pages read.
 */
export function queueDepthKey(
  organizationId: string,
  projectId: string,
  environmentId: string,
  queueName: string
): string {
  return `engine:runqueue:{org:${organizationId}}:proj:${projectId}:env:${environmentId}:queue:${queueName}`;
}

export type RedisLike = {
  del: (key: string) => Promise<unknown>;
  zadd: (key: string, ...args: Array<string | number>) => Promise<unknown>;
  zcard: (key: string) => Promise<number>;
  quit: () => Promise<unknown>;
};

/** Opens a client against the local run-queue Redis, or null if it isn't local. */
export async function openRedis(): Promise<RedisLike | null> {
  const connection = redisConnection();
  if (!connection) return null;
  const { createRedisClient } = await import("@internal/redis");
  return createRedisClient(connection) as unknown as RedisLike;
}

/** Replaces a zset with `depth` members. Scores are timestamps: the queue's ages. */
export async function writeZsetDepth(
  redis: RedisLike,
  key: string,
  depth: number,
  memberPrefix: string,
  /** How old the oldest member is. The SLA watch reads the oldest score. */
  ageMinutes = 0
) {
  await redis.del(key);
  const oldest = Date.now() - ageMinutes * 60_000;
  for (let i = 0; i < depth; i += ZADD_BATCH) {
    const args: Array<string | number> = [];
    for (let j = i; j < Math.min(depth, i + ZADD_BATCH); j++) {
      args.push(oldest + j, `${memberPrefix}${j}`);
    }
    await redis.zadd(key, ...args);
  }
}

export async function writeRedisDepth(
  redis: RedisLike,
  organizationId: string,
  environmentId: string,
  depth: number
) {
  await writeZsetDepth(
    redis,
    envQueueKey(organizationId, environmentId),
    depth,
    "seed_agentex_queued_"
  );
}

/**
 * Stages the env-level depth, and — when a project and queue are named — the
 * per-queue depth too.
 */
export async function stageRedisDepth(
  organizationId: string,
  environmentId: string,
  depth: number,
  label: string,
  projectId?: string,
  queueName?: string,
  opts: { queueMemberCap?: number; ageMinutes?: number } = {}
) {
  const redis = await openRedis();
  if (!redis) return;
  try {
    await writeRedisDepth(redis, organizationId, environmentId, depth);
    if (projectId && queueName) {
      const staged = Math.min(depth, opts.queueMemberCap ?? DEFAULT_QUEUE_MEMBER_CAP);
      await writeZsetDepth(
        redis,
        queueDepthKey(organizationId, projectId, environmentId, queueName),
        staged,
        "seed_agentex_q_",
        opts.ageMinutes
      );
      console.log(`[${label}] staged ${queueName} queue depth ${staged} in Redis`);
    }
    await redis.quit();
    console.log(`[${label}] staged env-queue depth ${depth} in Redis`);
  } catch (error) {
    console.warn(
      `[${label}] Redis staging skipped:`,
      error instanceof Error ? error.message : error
    );
  }
}

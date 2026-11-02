import type { Redis } from "@internal/redis";
import { RunQueueFullKeyProducer } from "../keyProducer.js";

/**
 * Seeds a keyspace shaped like prod for the concurrency sweeper: `concurrencySets` queue
 * currentConcurrency sets (the only keys the sweeper's MATCH accepts), each surrounded by
 * `unrelatedPerSet` keys the MATCH/TYPE filter has to skip (env currentConcurrency set,
 * currentDequeued set, queue zset, message strings). Returns every run id put in a
 * matching set, i.e. exactly what one full sweep must hand to the callback.
 */
export async function seedSweeperKeyspace(
  redis: Redis,
  { concurrencySets, unrelatedPerSet }: { concurrencySets: number; unrelatedPerSet: number }
): Promise<Set<string>> {
  const keys = new RunQueueFullKeyProducer();
  const expected = new Set<string>();
  const batch = 500;

  for (let start = 0; start < concurrencySets; start += batch) {
    const pipeline = redis.pipeline();
    for (let i = start; i < Math.min(start + batch, concurrencySets); i++) {
      const env = {
        id: `e${i % 997}`,
        type: "PRODUCTION" as const,
        project: { id: `p${i % 997}` },
        organization: { id: `o${i % 331}` },
      };
      const queue = `task/q${i}`;
      const runIds = Array.from({ length: (i % 3) + 1 }, (_, j) => `run_${i}_${j}`);
      runIds.forEach((id) => expected.add(id));
      pipeline.sadd(keys.queueCurrentConcurrencyKey(env, queue), ...runIds);

      const unrelated = [
        () => pipeline.sadd(keys.envCurrentConcurrencyKey(env), ...runIds),
        () => pipeline.sadd(keys.queueCurrentDequeuedKey(env, queue), ...runIds),
        () => pipeline.zadd(keys.queueKey(env, queue), Date.now(), runIds[0]!),
      ];
      for (let u = 0; u < unrelatedPerSet; u++) {
        if (u < unrelated.length) unrelated[u]!();
        else pipeline.set(keys.messageKey(env.organization.id, `msg_${i}_${u}`), "{}");
      }
    }
    await pipeline.exec();
  }

  return expected;
}

/** Cumulative calls of `command` the server has handled, from INFO commandstats. */
export async function commandCalls(redis: Redis, command: string): Promise<number> {
  const info = await redis.info("commandstats");
  const match = info.match(new RegExp(`cmdstat_${command}:calls=(\\d+)`));
  return match ? Number(match[1]) : 0;
}

import {
  Cluster,
  createRedisClient,
  createRedisClusterClient,
  type RedisClient,
} from "@internal/redis";
import {
  expectOneSlot,
  hasLocalRedisServer,
  redisTest,
  startLocalRedisCluster,
  type LocalRedisCluster,
} from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  DRRScheduler,
  FairQueue,
  FixedDelayRetry,
  TenantQueueFullError,
  TenantShardedFairQueueKeyProducer,
  WorkerQueueManager,
  type FairQueueRedisOptions,
} from "../index.js";

const Payload = z.object({ value: z.string(), blob: z.string().optional() });
type Payload = z.infer<typeof Payload>;

const WORKER_QUEUE = "wq";
const SHARDS = 16;

function tenantOf(queueId: string) {
  return queueId.split(":")[1] ?? queueId;
}

function queueFor(tenant: string, n: number) {
  return `tenant:${tenant}:q:${n}`;
}

function keyProducer() {
  return new TenantShardedFairQueueKeyProducer({
    prefix: "fq-test",
    shardCount: SHARDS,
    extractTenantId: tenantOf,
    extractGroupId: (groupName, queueId) => (groupName === "tenant" ? tenantOf(queueId) : ""),
  });
}

type Outcome = "complete" | "fail" | "hang";

function createQueue(
  redis: FairQueueRedisOptions,
  options: {
    logger?: Logger;
    visibilityTimeoutMs?: number;
    reconcileIntervalMs?: number;
    bytesLimit?: number;
  } = {}
) {
  const keys = keyProducer();
  const logger = options.logger ?? new Logger("tenant-sharded-test", "error");
  const fairQueue = new FairQueue({
    redis,
    keys,
    scheduler: new DRRScheduler({ redis, keys, quantum: 10, maxDeficit: 50 }),
    payloadSchema: Payload,
    separatePayloads: true,
    tenantPayloadBytesLimit: () => options.bytesLimit ?? 0,
    startConsumers: false,
    cooloff: { enabled: false },
    consumerIntervalMs: 20,
    visibilityTimeoutMs: options.visibilityTimeoutMs ?? 30_000,
    reclaimIntervalMs: 200,
    reconcileIntervalMs: options.reconcileIntervalMs ?? 0,
    workerQueue: { resolveWorkerQueue: () => WORKER_QUEUE },
    concurrencyGroups: [
      {
        name: "tenant",
        extractGroupId: (queue) => queue.tenantId,
        getLimit: async () => 5,
        defaultLimit: 5,
      },
    ],
    retry: {
      strategy: new FixedDelayRetry({ maxAttempts: 3, delayMs: 50 }),
      deadLetterQueue: false,
    },
    logger,
  });
  const workerQueue = new WorkerQueueManager({ redis, keys });
  return { keys, fairQueue, workerQueue };
}

/** Pops and settles messages until `done()` or the timeout, returning every message it saw. */
async function consume(
  queue: ReturnType<typeof createQueue>,
  decide: (id: string, attempt: number, payload: Payload) => Outcome,
  done: () => boolean,
  timeoutMs = 20_000
) {
  const seen: Array<{ id: string; attempt: number; payload: Payload }> = [];
  const deadline = Date.now() + timeoutMs;
  while (!done() && Date.now() < deadline) {
    const popped = await queue.workerQueue.pop(WORKER_QUEUE);
    if (!popped) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    const colon = popped.messageKey.indexOf(":");
    const messageId = popped.messageKey.slice(0, colon);
    const queueId = popped.messageKey.slice(colon + 1);
    const stored = await queue.fairQueue.getMessageData(messageId, queueId);
    if (!stored) continue;
    seen.push({ id: messageId, attempt: stored.attempt, payload: stored.payload });
    const outcome = decide(messageId, stored.attempt, stored.payload);
    if (outcome === "complete") await queue.fairQueue.completeMessage(messageId, queueId);
    if (outcome === "fail") await queue.fairQueue.failMessage(messageId, queueId, new Error("x"));
  }
  return seen;
}

describe("TenantShardedFairQueueKeyProducer", () => {
  it("keeps every key a script touches in one slot", () => {
    const keys = keyProducer();
    for (let t = 0; t < 200; t++) {
      const tenant = `env_${t.toString(36)}abc`;
      const shard = keys.tenantShard(tenant);
      for (let q = 0; q < 3; q++) {
        const queueId = queueFor(tenant, q);
        const messageId = `msg_${t}_${q}`;
        expectOneSlot([
          keys.queueKey(queueId),
          keys.queueItemsKey(queueId),
          keys.tenantQueueIndexKey(tenant),
          keys.dispatchKey(shard),
          keys.payloadKey(queueId, messageId),
          keys.inflightKey(shard),
          keys.inflightDataKey(shard),
          keys.masterQueueKey(shard),
          keys.concurrencyKey("tenant", tenant),
          keys.tenantPayloadBytesKey(tenant),
          keys.deadLetterQueueKey(tenant),
          keys.deadLetterQueueDataKey(tenant),
        ]);
      }
    }
  });

  it("puts a tenant on the same shard whatever its queue", () => {
    const keys = keyProducer();
    expect(keys.tenantShard("env_a")).toBe(keys.tenantShard(tenantOf(queueFor("env_a", 7))));
    expect(new Set(Array.from({ length: 500 }, (_, i) => keys.tenantShard(`env_${i}`))).size).toBe(
      SHARDS
    );
  });
});

describe("separate payloads", () => {
  redisTest(
    "writes the payload once, keeps it out of the queue and in-flight entries, and deletes it on completion",
    async ({ redisOptions }) => {
      const queue = createQueue(redisOptions);
      const raw = createRedisClient(redisOptions);
      try {
        const queueId = queueFor("env_a", 1);
        const payload = { value: "a", blob: "x".repeat(2_000) };
        await queue.fairQueue.enqueue({ queueId, tenantId: "env_a", messageId: "m1", payload });

        const envelope = JSON.parse((await raw.hget(queue.keys.queueItemsKey(queueId), "m1"))!);
        expect(envelope.payload).toBeUndefined();
        expect(JSON.parse((await raw.get(queue.keys.payloadKey(queueId, "m1")))!)).toEqual(payload);

        queue.fairQueue.start();
        let attempts = 0;
        const seen = await consume(
          queue,
          (_id, attempt) => {
            attempts = attempt;
            return attempt === 1 ? "fail" : "complete";
          },
          () => attempts >= 2
        );
        await queue.fairQueue.stop();

        expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
        expect(seen.every((s) => s.payload.blob === payload.blob)).toBe(true);
        expect(await raw.exists(queue.keys.payloadKey(queueId, "m1"))).toBe(0);
        expect(await raw.hlen(queue.keys.inflightDataKey(queue.keys.tenantShard("env_a")))).toBe(0);
      } finally {
        await raw.quit();
        await queue.fairQueue.close();
        await queue.workerQueue.close();
      }
    }
  );

  redisTest("leaves an id that is already queued or in flight alone", async ({ redisOptions }) => {
    const queue = createQueue(redisOptions);
    const raw = createRedisClient(redisOptions);
    try {
      const queueId = queueFor("env_b", 1);
      const payloadKey = queue.keys.payloadKey(queueId, "m1");
      await queue.fairQueue.enqueue({
        queueId,
        tenantId: "env_b",
        messageId: "m1",
        payload: { value: "first" },
      });
      await queue.fairQueue.enqueue({
        queueId,
        tenantId: "env_b",
        messageId: "m1",
        payload: { value: "second" },
      });
      expect(JSON.parse((await raw.get(payloadKey))!).value).toBe("first");

      queue.fairQueue.start();
      let claimed = false;
      await consume(
        queue,
        () => {
          claimed = true;
          return "hang";
        },
        () => claimed
      );
      await queue.fairQueue.stop();
      expect(await queue.fairQueue.getTotalInflightCount()).toBe(1);

      await queue.fairQueue.enqueue({
        queueId,
        tenantId: "env_b",
        messageId: "m1",
        payload: { value: "third" },
      });
      expect(await queue.fairQueue.getQueueLength(queueId)).toBe(0);
      expect(JSON.parse((await raw.get(payloadKey))!).value).toBe("first");

      await queue.fairQueue.completeMessage("m1", queueId);
      await queue.fairQueue.enqueue({
        queueId,
        tenantId: "env_b",
        messageId: "m1",
        payload: { value: "fourth" },
      });
      expect(await queue.fairQueue.getQueueLength(queueId)).toBe(1);
      expect(JSON.parse((await raw.get(payloadKey))!).value).toBe("fourth");
    } finally {
      await raw.quit();
      await queue.fairQueue.close();
      await queue.workerQueue.close();
    }
  });

  redisTest(
    "counts a tenant's payload bytes and refuses an enqueue past its limit",
    async ({ redisOptions }) => {
      const queue = createQueue(redisOptions, { bytesLimit: 1_500 });
      try {
        const queueId = queueFor("env_c", 1);
        const big = { value: "a", blob: "z".repeat(600) };
        const size = JSON.stringify(big).length;
        await queue.fairQueue.enqueue({
          queueId,
          tenantId: "env_c",
          messageId: "m1",
          payload: big,
        });
        await queue.fairQueue.enqueue({
          queueId,
          tenantId: "env_c",
          messageId: "m2",
          payload: big,
        });
        expect(await queue.fairQueue.getTenantPayloadBytes("env_c")).toBe(size * 2);
        await expect(
          queue.fairQueue.enqueue({ queueId, tenantId: "env_c", messageId: "m3", payload: big })
        ).rejects.toBeInstanceOf(TenantQueueFullError);
        await queue.fairQueue.enqueue({
          queueId: queueFor("env_d", 1),
          tenantId: "env_d",
          messageId: "m3",
          payload: big,
        });

        queue.fairQueue.start();
        const settled = new Set<string>();
        await consume(
          queue,
          (id, attempt) => {
            if (id === "m1" && attempt === 1) return "fail";
            settled.add(id);
            return "complete";
          },
          () => settled.size === 3
        );
        await queue.fairQueue.stop();

        expect(await queue.fairQueue.getTenantPayloadBytes("env_c")).toBe(0);
        expect(await queue.fairQueue.getTenantPayloadBytes("env_d")).toBe(0);
        await queue.fairQueue.enqueue({
          queueId,
          tenantId: "env_c",
          messageId: "m4",
          payload: big,
        });
        expect(await queue.fairQueue.getTenantPayloadBytes("env_c")).toBe(size);
      } finally {
        await queue.fairQueue.close();
        await queue.workerQueue.close();
      }
    }
  );

  redisTest(
    "an enqueue refused for memory leaves no payload, byte charge or queue entry",
    async ({ redisOptions }) => {
      const queue = createQueue(redisOptions);
      const raw = createRedisClient(redisOptions);
      const queueId = queueFor("env_oom", 1);
      try {
        await raw.config("SET", "maxmemory-policy", "noeviction");
        await raw.config("SET", "maxmemory", "1");
        await expect(
          queue.fairQueue.enqueue({
            queueId,
            tenantId: "env_oom",
            messageId: "m1",
            payload: { value: "a", blob: "x".repeat(1_000) },
          })
        ).rejects.toThrow(/OOM/);
        await raw.config("SET", "maxmemory", "0");

        expect(await raw.exists(queue.keys.payloadKey(queueId, "m1"))).toBe(0);
        expect(await queue.fairQueue.getTenantPayloadBytes("env_oom")).toBe(0);
        expect(await queue.fairQueue.getQueueLength(queueId)).toBe(0);
      } finally {
        await raw.config("SET", "maxmemory", "0");
        await raw.quit();
        await queue.fairQueue.close();
        await queue.workerQueue.close();
      }
    }
  );

  redisTest(
    "ignorePayloadBytesLimit enqueues past the limit and still counts the bytes",
    async ({ redisOptions }) => {
      const queue = createQueue(redisOptions, { bytesLimit: 100 });
      try {
        const queueId = queueFor("env_internal", 1);
        const payload = { value: "a", blob: "y".repeat(500) };
        await expect(
          queue.fairQueue.enqueue({ queueId, tenantId: "env_internal", messageId: "m1", payload })
        ).rejects.toBeInstanceOf(TenantQueueFullError);
        await queue.fairQueue.enqueue({
          queueId,
          tenantId: "env_internal",
          messageId: "m2",
          payload,
          ignorePayloadBytesLimit: true,
        });
        expect(await queue.fairQueue.getTenantPayloadBytes("env_internal")).toBe(
          JSON.stringify(payload).length
        );
      } finally {
        await queue.fairQueue.close();
        await queue.workerQueue.close();
      }
    }
  );

  it("refuses a shard count that disagrees with the key producer", () => {
    expect(
      () =>
        new FairQueue({
          redis: { cluster: { nodes: [{ host: "127.0.0.1", port: 1 }] } },
          keys: new (class extends TenantShardedFairQueueKeyProducer {})({
            prefix: "x",
            shardCount: 2,
            extractTenantId: tenantOf,
            extractGroupId: () => "",
          }),
          scheduler: { selectQueues: async () => [] },
          startConsumers: false,
          workerQueue: { resolveWorkerQueue: () => WORKER_QUEUE },
          shardCount: 3,
        })
    ).toThrow(/doesn't match/);
  });
});

/**
 * Against a real cluster (RUN_REDIS_CLUSTER_TEST=1 and valkey-server or redis-server installed),
 * the only place a script whose keys span slots fails with CROSSSLOT.
 */
describe.skipIf(!hasLocalRedisServer() || process.env.RUN_REDIS_CLUSTER_TEST !== "1")(
  "tenant-sharded fair queue on a Redis cluster",
  () => {
    let cluster: LocalRedisCluster;
    let admin: Cluster;
    let connection: FairQueueRedisOptions;

    beforeAll(async () => {
      cluster = await startLocalRedisCluster({ primaries: 3 });
      connection = {
        cluster: {
          nodes: cluster.nodes,
          clusterOptions: { keyPrefix: "fq:", slotsRefreshTimeout: 10_000 },
        },
      };
      admin = createRedisClusterClient({ nodes: cluster.nodes });
    }, 60_000);

    afterAll(async () => {
      await admin?.quit().catch(() => {});
      await cluster?.stop();
    });

    async function countKeys(client: RedisClient, pattern: string) {
      const nodes = client instanceof Cluster ? client.nodes("master") : [client];
      let total = 0;
      for (const node of nodes) total += (await node.keys(pattern)).length;
      return total;
    }

    it("delivers every message exactly once through retries, lease expiry and the concurrency sweep", async () => {
      const errors: string[] = [];
      const logger = new Logger("tenant-sharded-cluster", "error");
      logger.error = (message: string, ...args: unknown[]) => {
        errors.push(`${message} ${JSON.stringify(args)}`);
      };
      const queue = createQueue(connection, {
        logger,
        visibilityTimeoutMs: 1_000,
        reconcileIntervalMs: 300,
      });

      const ids: string[] = [];
      for (let t = 0; t < 40; t++) {
        for (let q = 0; q < 3; q++) {
          for (let m = 0; m < 3; m++) {
            const id = `m_${t}_${q}_${m}`;
            ids.push(id);
            await queue.fairQueue.enqueue({
              queueId: queueFor(`env_${t}`, q),
              tenantId: `env_${t}`,
              messageId: id,
              payload: { value: id, blob: "y".repeat(500) },
            });
          }
        }
      }

      queue.fairQueue.start();
      const completed = new Set<string>();
      const completions: string[] = [];
      const hung = new Set<string>();
      await consume(
        queue,
        (id, attempt, payload) => {
          expect(payload.value).toBe(id);
          const n = Number(id.split("_")[3]);
          if (n === 1 && attempt === 1) return "fail";
          if (n === 2 && !hung.has(id)) {
            hung.add(id);
            return "hang";
          }
          completed.add(id);
          completions.push(id);
          return "complete";
        },
        () => completed.size === ids.length,
        60_000
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      await queue.fairQueue.stop();

      expect(completed.size).toBe(ids.length);
      expect(completions.length).toBe(ids.length);
      expect(await queue.fairQueue.getTotalInflightCount()).toBe(0);
      expect(await countKeys(admin, "fq:*:payload:*")).toBe(0);
      expect(await countKeys(admin, "fq:*:payloadbytes:*")).toBe(0);
      expect(errors.filter((e) => /CROSSSLOT|slot/i.test(e))).toEqual([]);

      await queue.fairQueue.close();
      await queue.workerQueue.close();
    }, 90_000);
  }
);

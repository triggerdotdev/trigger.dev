import { containerTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { parsePacket } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import { Redis } from "ioredis";
import { describe, expect } from "vitest";
import {
  FallbackMetadataOperationBuffer,
  InMemoryMetadataOperationBuffer,
  RedisMetadataOperationBuffer,
} from "~/services/metadata/operationBuffer.server";
import { UpdateMetadataService } from "~/services/metadata/updateMetadata.server";
import { gaugeValue, latestMetrics, metricSum } from "./otlpMetrics.helpers";
import { createInMemoryMetrics } from "./utils/tracing";

vi.setConfig({ testTimeout: 20_000 });

async function seedEnvironment(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: { title: "test", slug: "test" },
  });
  const project = await prisma.project.create({
    data: { name: "test", slug: "test", organizationId: organization.id, externalRef: "test" },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "test",
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "test",
      pkApiKey: "test",
      shortcode: "test",
    },
  });
  return { organization, project, environment };
}

async function createRun(
  prisma: PrismaClient,
  env: Awaited<ReturnType<typeof seedEnvironment>>,
  friendlyId: string,
  parentTaskRunId?: string,
  rootTaskRunId?: string
) {
  return prisma.taskRun.create({
    data: {
      friendlyId,
      taskIdentifier: "my-task",
      payload: JSON.stringify({ foo: "bar" }),
      traceId: "1234",
      spanId: "1234",
      queue: "test",
      runtimeEnvironmentId: env.environment.id,
      projectId: env.project.id,
      organizationId: env.organization.id,
      environmentType: "DEVELOPMENT",
      engine: "V2",
      parentTaskRunId,
      rootTaskRunId,
    },
  });
}

async function readMetadata(prisma: PrismaClient, runId: string) {
  const run = await prisma.taskRun.findUnique({ where: { id: runId } });
  if (!run?.metadata) return undefined;
  return parsePacket({ data: run.metadata, dataType: run.metadataType });
}

async function bumpMetadataVersion(prisma: PrismaClient, runId: string) {
  await prisma.taskRun.updateMany({
    where: { id: runId },
    data: { metadataVersion: { increment: 1 } },
  });
}

describe("UpdateMetadataService flusher", () => {
  containerTest(
    "gives up on a run that keeps losing the version check and keeps its operations",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      let contended = true;
      let parentReads = 0;
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        flushEnabled: false,
        flushMaxRetries: 2,
        onAfterRead: async (runId) => {
          if (runId !== parent.id || !contended) return;
          parentReads++;
          await bumpMetadataVersion(prisma, runId);
        },
      });

      await service.call(child.id, {
        parentOperations: [{ type: "set", key: "progress", value: 1 }],
      });

      await service.flushOperations();

      expect(parentReads).toBe(3);
      expect(await readMetadata(prisma, parent.id)).toBeUndefined();

      contended = false;
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ progress: 1 });

      service.stopFlushing();
    }
  );

  containerTest("drops buffered operations for a run that no longer exists", async ({ prisma }) => {
    const env = await seedEnvironment(prisma);
    const run = await createRun(prisma, env, "run_gone");

    let reads = 0;
    const service = new UpdateMetadataService({
      prisma,
      runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
      flushEnabled: false,
      onAfterRead: async (runId) => {
        reads++;
        if (reads <= 4) await bumpMetadataVersion(prisma, runId);
      },
    });

    await service.call(run.id, { operations: [{ type: "set", key: "a", value: 1 }] });
    await prisma.taskRun.delete({ where: { id: run.id } });

    await service.flushOperations();
    await service.flushOperations();

    expect(reads).toBe(4);

    service.stopFlushing();
  });

  containerTest(
    "flushes other runs while one run keeps losing the version check",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const hotParent = await createRun(prisma, env, "run_hot");
      const hotChild = await createRun(prisma, env, "run_hot_child", hotParent.id);
      const quietParent = await createRun(prisma, env, "run_quiet");
      const quietChild = await createRun(prisma, env, "run_quiet_child", quietParent.id);

      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        flushEnabled: false,
        flushMaxRetries: 2,
        onAfterRead: async (runId) => {
          if (runId === hotParent.id) await bumpMetadataVersion(prisma, runId);
        },
      });

      await service.call(hotChild.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });
      await service.call(quietChild.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });

      await service.flushOperations();

      expect(await readMetadata(prisma, quietParent.id)).toEqual({ done: 1 });
      expect(await readMetadata(prisma, hotParent.id)).toBeUndefined();

      service.stopFlushing();
    }
  );

  containerTest(
    "redis buffer: processes sharing a buffer write a hot parent once per flush",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const children = await Promise.all(
        [1, 2, 3, 4].map((i) => createRun(prisma, env, `run_child_${i}`, parent.id))
      );

      const clients: Redis[] = [];
      let parentWrites = 0;
      const services = [0, 1].map(() => {
        const redis = new Redis(redisOptions);
        clients.push(redis);
        return new UpdateMetadataService({
          prisma,
          runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
          buffer: new RedisMetadataOperationBuffer({ redis, flushDelayMs: 0 }),
          flushEnabled: false,
          onBeforeUpdate: async (runId) => {
            if (runId === parent.id) parentWrites++;
          },
        });
      });

      await Promise.all(
        children.map((child, i) =>
          services[i % 2].call(child.id, {
            parentOperations: [{ type: "increment", key: "done", value: 1 }],
          })
        )
      );

      await Promise.all(services.map((service) => service.flushOperations()));

      expect(parentWrites).toBe(1);
      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 4 });

      for (const service of services) service.stopFlushing();
      await Promise.all(clients.map((client) => client.quit()));
    }
  );

  containerTest(
    "redis buffer: operations buffered by a process that exits are flushed by another",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const writerRedis = new Redis(redisOptions);
      const writer = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new RedisMetadataOperationBuffer({ redis: writerRedis }),
        flushEnabled: false,
      });

      await writer.call(child.id, {
        parentOperations: [{ type: "set", key: "foo", value: "bar" }],
      });
      writer.stopFlushing();
      await writerRedis.quit();

      const restartedRedis = new Redis(redisOptions);
      const restarted = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new RedisMetadataOperationBuffer({ redis: restartedRedis }),
        flushEnabled: false,
      });
      await restarted.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ foo: "bar" });

      restarted.stopFlushing();
      await restartedRedis.quit();
    }
  );

  containerTest(
    "does not re-apply a write that committed before its error surfaced",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const runStore = new UnreliableWriteRunStore({ prisma, readOnlyPrisma: prisma });
      const service = new UpdateMetadataService({ prisma, runStore, flushEnabled: false });

      await service.call(child.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });

      runStore.failNextWrite = "after-commit";
      await service.flushOperations();
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
    }
  );

  containerTest("re-applies a write that failed before committing", async ({ prisma }) => {
    const env = await seedEnvironment(prisma);
    const parent = await createRun(prisma, env, "run_parent");
    const child = await createRun(prisma, env, "run_child", parent.id);

    const runStore = new UnreliableWriteRunStore({ prisma, readOnlyPrisma: prisma });
    const service = new UpdateMetadataService({ prisma, runStore, flushEnabled: false });

    await service.call(child.id, {
      parentOperations: [{ type: "increment", key: "done", value: 1 }],
    });

    runStore.failNextWrite = "before-commit";
    await service.flushOperations();
    expect(await readMetadata(prisma, parent.id)).toBeUndefined();

    await service.flushOperations();
    expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

    service.stopFlushing();
  });

  containerTest(
    "redis buffer: a write whose acknowledgement was lost is not applied again by another process",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const firstRedis = new Redis(redisOptions);
      const firstBuffer = new LostAckBuffer({ redis: firstRedis, lockTtlMs: 200 });
      const first = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: firstBuffer,
        flushEnabled: false,
      });

      await first.call(child.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });
      await first.flushOperations();
      expect(firstBuffer.lostAcks).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const secondRedis = new Redis(redisOptions);
      const secondBuffer = new RedisMetadataOperationBuffer({ redis: secondRedis });
      const second = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: secondBuffer,
        flushEnabled: false,
      });
      await second.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });
      expect(await secondBuffer.size()).toBe(0);

      first.stopFlushing();
      second.stopFlushing();
      await Promise.all([firstRedis.quit(), secondRedis.quit()]);
    }
  );

  containerTest(
    "redis buffer: a child update still succeeds when redis is down and its operations flush from memory",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const fallbacks: string[] = [];
      const primary = new UnavailableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
          onFallback: (action) => fallbacks.push(action),
        }),
        flushEnabled: false,
      });

      await service.call(child.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });
      expect(fallbacks).toEqual(["ingest", "claim"]);
      expect(primary.ingestCalls).toBe(0);

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest("reports pending runs and requeue reasons as metrics", async ({ prisma }) => {
    const env = await seedEnvironment(prisma);
    const hotParent = await createRun(prisma, env, "run_hot");
    const hotChild = await createRun(prisma, env, "run_hot_child", hotParent.id);
    const otherParent = await createRun(prisma, env, "run_other");
    const otherChild = await createRun(prisma, env, "run_other_child", otherParent.id);

    const metrics = createInMemoryMetrics();
    const runStore = new UnreliableWriteRunStore({ prisma, readOnlyPrisma: prisma });
    const service = new UpdateMetadataService({
      prisma,
      runStore,
      flushEnabled: false,
      flushMaxRetries: 1,
      meter: metrics.meter,
      onAfterRead: async (runId) => {
        if (runId === hotParent.id) await bumpMetadataVersion(prisma, runId);
      },
    });

    await service.call(hotChild.id, {
      parentOperations: [{ type: "increment", key: "done", value: 1 }],
    });
    await service.call(otherChild.id, {
      parentOperations: [{ type: "increment", key: "done", value: 1 }],
    });

    runStore.failNextWriteFor = otherParent.id;
    await service.flushOperations();

    const rm = await latestMetrics(metrics);
    expect(metricSum(rm, "metadata.buffer.requeues", { reason: "retries_exhausted" })).toBe(1);
    expect(metricSum(rm, "metadata.buffer.requeues", { reason: "unknown_outcome" })).toBe(1);
    expect(gaugeValue(rm, "metadata.buffer.runs_pending", {})).toBe(2);

    service.stopFlushing();
    await metrics.shutdown();
  });

  containerTest(
    "redis buffer: counts fallbacks to memory by action",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const metrics = createInMemoryMetrics();
      const redis = new Redis(redisOptions);
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary: new UnavailableRedisBuffer({ redis }),
          fallback: new InMemoryMetadataOperationBuffer(),
          meter: metrics.meter,
        }),
        flushEnabled: false,
      });

      await service.call(child.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });
      await service.flushOperations();

      const rm = await latestMetrics(metrics);
      expect(metricSum(rm, "metadata.buffer.fallbacks", { action: "ingest" })).toBe(1);
      expect(metricSum(rm, "metadata.buffer.fallbacks", { action: "claim" })).toBe(1);

      service.stopFlushing();
      await redis.quit();
      await metrics.shutdown();
    }
  );

  containerTest(
    "requeues a write that never reached the database instead of retrying it in place",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const runStore = new UnreliableWriteRunStore({ prisma, readOnlyPrisma: prisma });
      const service = new UpdateMetadataService({ prisma, runStore, flushEnabled: false });

      await service.call(child.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });

      runStore.failNextWrite = "pool-timeout";
      await service.flushOperations();
      expect(runStore.writeAttempts).toBe(1);
      expect(await readMetadata(prisma, parent.id)).toBeUndefined();

      await service.flushOperations();
      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
    }
  );

  containerTest(
    "does not re-apply a write whose connection dropped after it committed",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const runStore = new UnreliableWriteRunStore({ prisma, readOnlyPrisma: prisma });
      const service = new UpdateMetadataService({ prisma, runStore, flushEnabled: false });

      await service.call(child.id, {
        parentOperations: [{ type: "increment", key: "done", value: 1 }],
      });

      runStore.failNextWrite = "connection-lost-after-commit";
      await service.flushOperations();
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
    }
  );

  containerTest(
    "redis buffer: a retried request whose first ingest landed is not buffered twice",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new LostIngestReplyBuffer({ redis }),
        flushEnabled: false,
      });

      const body = { parentOperations: [{ type: "increment" as const, key: "done", value: 1 }] };
      const options = { requestIdempotencyKey: "req-1" };

      await expect(service.call(child.id, body, undefined, options)).rejects.toThrow("reply lost");
      await service.call(child.id, body, undefined, options);
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: an ingest that fails while connected fails the request without falling back",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const fallback = new InMemoryMetadataOperationBuffer();
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary: new ConnectedFailingRedisBuffer({ redis }),
          fallback,
        }),
        flushEnabled: false,
      });

      await expect(
        service.call(child.id, {
          parentOperations: [{ type: "increment", key: "done", value: 1 }],
        })
      ).rejects.toThrow("connection lost mid-command");
      expect(await fallback.size()).toBe(0);

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: a retry that moves from redis to memory after a lost reply is applied once",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      const body = { parentOperations: [{ type: "increment" as const, key: "done", value: 1 }] };
      const options = { requestIdempotencyKey: "req-1" };

      primary.loseNextReply = true;
      await expect(service.call(child.id, body, undefined, options)).rejects.toThrow("reply lost");

      primary.available = false;
      await service.call(child.id, body, undefined, options);

      primary.available = true;
      await service.flushOperations();
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: a retry that moves from memory to redis is applied once",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const childA = await createRun(prisma, env, "run_child_a", parent.id);
      const childB = await createRun(prisma, env, "run_child_b", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      const body = { parentOperations: [{ type: "increment" as const, key: "done", value: 1 }] };

      primary.available = false;
      await service.call(childA.id, body, undefined, { requestIdempotencyKey: "req-a" });
      primary.available = true;
      await service.call(childA.id, body, undefined, { requestIdempotencyKey: "req-a" });
      await service.flushOperations();

      primary.available = false;
      await service.call(childB.id, body, undefined, { requestIdempotencyKey: "req-b" });
      primary.available = true;
      await service.flushOperations();
      await service.call(childB.id, body, undefined, { requestIdempotencyKey: "req-b" });
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 2 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: memory operations from an idempotent request wait for redis before applying",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      primary.available = false;
      await service.call(
        child.id,
        { parentOperations: [{ type: "increment", key: "done", value: 1 }] },
        undefined,
        { requestIdempotencyKey: "req-1" }
      );
      await service.flushOperations();
      expect(await readMetadata(prisma, parent.id)).toBeUndefined();

      primary.available = true;
      await service.flushOperations();
      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: a lost reply while handing memory operations to redis does not drop them",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      primary.available = false;
      await service.call(
        child.id,
        { parentOperations: [{ type: "increment", key: "done", value: 1 }] },
        undefined,
        { requestIdempotencyKey: "req-1" }
      );

      primary.available = true;
      primary.loseNextReply = true;
      await service.flushOperations();
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: memory operations handed to redis survive a restart before they are written",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const runStore = new UnreliableWriteRunStore({ prisma, readOnlyPrisma: prisma });
      const first = new UpdateMetadataService({
        prisma,
        runStore,
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      primary.available = false;
      await first.call(
        child.id,
        { parentOperations: [{ type: "increment", key: "done", value: 1 }] },
        undefined,
        { requestIdempotencyKey: "req-1" }
      );

      primary.available = true;
      runStore.failNextWrite = "before-commit";
      await first.flushOperations();
      first.stopFlushing();

      const restartedRedis = new Redis(redisOptions);
      await restartedRedis.ping();
      const restarted = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary: new RedisMetadataOperationBuffer({ redis: restartedRedis }),
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });
      await restarted.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      restarted.stopFlushing();
      await Promise.all([redis.quit(), restartedRedis.quit()]);
    }
  );

  containerTest(
    "redis buffer: memory operations keep their order when only some came from an idempotent request",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      primary.available = false;
      await service.call(
        child.id,
        { parentOperations: [{ type: "set", key: "status", value: "started" }] },
        undefined,
        { requestIdempotencyKey: "req-1" }
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.call(child.id, {
        parentOperations: [{ type: "set", key: "status", value: "finished" }],
      });

      primary.available = true;
      await service.flushOperations();
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ status: "finished" });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: memory operations stay queued while a connected redis rejects the handoff",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      primary.available = false;
      await service.call(
        child.id,
        { parentOperations: [{ type: "increment", key: "done", value: 1 }] },
        undefined,
        { requestIdempotencyKey: "req-1" }
      );

      primary.available = true;
      primary.rejectIngest = true;
      await service.flushOperations();
      expect(await readMetadata(prisma, parent.id)).toBeUndefined();

      primary.rejectIngest = false;
      await service.flushOperations();
      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: keyed memory operations queued behind a fenced write are still handed to redis",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const childA = await createRun(prisma, env, "run_child_a", parent.id);
      const childB = await createRun(prisma, env, "run_child_b", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const runStore = new UnreliableWriteRunStore({ prisma, readOnlyPrisma: prisma });
      const service = new UpdateMetadataService({
        prisma,
        runStore,
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      const body = { parentOperations: [{ type: "increment" as const, key: "done", value: 1 }] };

      primary.available = false;
      await service.call(childA.id, body);
      runStore.failNextWrite = "after-commit";
      await service.flushOperations();

      await service.call(childB.id, body, undefined, { requestIdempotencyKey: "req-b" });
      primary.available = true;
      await service.flushOperations();
      await service.flushOperations();

      await service.call(childB.id, body, undefined, { requestIdempotencyKey: "req-b" });
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 2 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: held fallback runs do not block runs already buffered in redis",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const heldParent = await createRun(prisma, env, "run_held_parent");
      const heldChild = await createRun(prisma, env, "run_held_child", heldParent.id);
      const redisParent = await createRun(prisma, env, "run_redis_parent");
      const redisChild = await createRun(prisma, env, "run_redis_child", redisParent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        drainBatchSize: 1,
        flushEnabled: false,
      });

      const body = { parentOperations: [{ type: "increment" as const, key: "done", value: 1 }] };

      primary.available = false;
      await service.call(heldChild.id, body, undefined, { requestIdempotencyKey: "req-held" });
      primary.available = true;
      await service.call(redisChild.id, body, undefined, { requestIdempotencyKey: "req-redis" });

      primary.rejectIngest = true;
      await service.flushOperations();

      expect(await readMetadata(prisma, redisParent.id)).toEqual({ done: 1 });
      expect(await readMetadata(prisma, heldParent.id)).toBeUndefined();

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: a run with held fallback operations is not drained from redis ahead of them",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        drainBatchSize: 1,
        flushEnabled: false,
      });

      primary.available = false;
      await service.call(
        child.id,
        { parentOperations: [{ type: "set", key: "status", value: "started" }] },
        undefined,
        { requestIdempotencyKey: "req-1" }
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      primary.available = true;
      await service.call(
        child.id,
        { parentOperations: [{ type: "set", key: "status", value: "finished" }] },
        undefined,
        { requestIdempotencyKey: "req-2" }
      );

      primary.rejectIngest = true;
      await service.flushOperations();
      expect(await readMetadata(prisma, parent.id)).toBeUndefined();

      primary.rejectIngest = false;
      await service.flushOperations();
      await service.flushOperations();
      expect(await readMetadata(prisma, parent.id)).toEqual({ status: "finished" });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "redis buffer: a failed release of a blocked redis claim does not lose other memory runs",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const localParent = await createRun(prisma, env, "run_local_parent");
      const localChild = await createRun(prisma, env, "run_local_child", localParent.id);
      const heldParent = await createRun(prisma, env, "run_held_parent");
      const heldChild = await createRun(prisma, env, "run_held_child", heldParent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis, lockTtlMs: 200 });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      const body = { parentOperations: [{ type: "increment" as const, key: "done", value: 1 }] };

      primary.available = false;
      await service.call(localChild.id, body);
      await service.call(heldChild.id, body, undefined, { requestIdempotencyKey: "req-1" });
      primary.available = true;
      await service.call(heldChild.id, body, undefined, { requestIdempotencyKey: "req-2" });

      primary.rejectIngest = true;
      primary.rejectRequeue = true;
      await service.flushOperations();

      expect(await readMetadata(prisma, localParent.id)).toEqual({ done: 1 });
      expect(await readMetadata(prisma, heldParent.id)).toBeUndefined();

      primary.rejectIngest = false;
      primary.rejectRequeue = false;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await service.flushOperations();
      await service.flushOperations();

      expect(await readMetadata(prisma, heldParent.id)).toEqual({ done: 2 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "rejects buffered operations past the per-run cap with a 429",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new InMemoryMetadataOperationBuffer({ maxPendingOperationsPerRun: 2 }),
        flushEnabled: false,
      });

      await expect(
        service.call(child.id, {
          parentOperations: [
            { type: "increment", key: "a", value: 1 },
            { type: "increment", key: "b", value: 1 },
            { type: "increment", key: "c", value: 1 },
          ],
        })
      ).rejects.toMatchObject({ status: 429 });

      service.stopFlushing();
    }
  );

  containerTest(
    "redis buffer: operations accepted into memory are handed off even when redis is at the run's cap",
    async ({ prisma, redisOptions }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const redis = new Redis(redisOptions);
      const primary = new SwitchableRedisBuffer({ redis, maxPendingOperationsPerRun: 1 });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer: new FallbackMetadataOperationBuffer({
          primary,
          fallback: new InMemoryMetadataOperationBuffer(),
        }),
        flushEnabled: false,
      });

      const body = { parentOperations: [{ type: "increment" as const, key: "done", value: 1 }] };

      primary.available = false;
      await service.call(child.id, body, undefined, { requestIdempotencyKey: "req-1" });
      primary.available = true;
      await service.call(child.id, body, undefined, { requestIdempotencyKey: "req-2" });

      await service.flushOperations();
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 2 });

      service.stopFlushing();
      await redis.quit();
    }
  );

  containerTest(
    "a request retried after its root operations hit the cap does not re-apply its parent operations",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const root = await createRun(prisma, env, "run_root");
      const parent = await createRun(prisma, env, "run_parent", root.id, root.id);
      const child = await createRun(prisma, env, "run_child", parent.id, root.id);

      const buffer = new InMemoryMetadataOperationBuffer({ maxPendingOperationsPerRun: 2 });
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer,
        flushEnabled: false,
      });

      await buffer.ingest(root.id, [
        {
          runId: root.id,
          timestamp: Date.now(),
          operation: { type: "increment", key: "x", value: 1 },
        },
        {
          runId: root.id,
          timestamp: Date.now(),
          operation: { type: "increment", key: "x", value: 1 },
        },
      ]);

      const body = {
        parentOperations: [{ type: "increment" as const, key: "done", value: 1 }],
        rootOperations: [{ type: "increment" as const, key: "done", value: 1 }],
      };
      const options = { requestIdempotencyKey: "req-1" };

      await expect(service.call(child.id, body, undefined, options)).rejects.toMatchObject({
        status: 429,
      });
      await expect(service.call(child.id, body, undefined, options)).rejects.toMatchObject({
        status: 429,
      });
      await service.flushOperations();

      expect(await readMetadata(prisma, parent.id)).toEqual({ done: 1 });

      service.stopFlushing();
    }
  );

  containerTest(
    "drops a buffered operation whose value can never fit the metadata size limit",
    async ({ prisma }) => {
      const env = await seedEnvironment(prisma);
      const parent = await createRun(prisma, env, "run_parent");
      const child = await createRun(prisma, env, "run_child", parent.id);

      const buffer = new InMemoryMetadataOperationBuffer();
      const service = new UpdateMetadataService({
        prisma,
        runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
        buffer,
        maximumSize: 1024,
        flushEnabled: false,
      });

      await service.call(child.id, {
        parentOperations: [
          { type: "set", key: "blob", value: "x".repeat(2048) },
          { type: "set", key: "near", value: "y".repeat(1000) },
          { type: "increment", key: "done", value: 1 },
        ],
      });

      const [claim] = await buffer.claimDue(10);
      expect(claim.operations.map((op) => op.operation.key)).toEqual(["near", "done"]);

      service.stopFlushing();
    }
  );
});

class SwitchableRedisBuffer extends RedisMetadataOperationBuffer {
  available = true;
  loseNextReply = false;
  rejectIngest = false;
  rejectRequeue = false;

  override async requeue(...args: Parameters<RedisMetadataOperationBuffer["requeue"]>) {
    if (this.rejectRequeue) throw new Error("connection reset");
    return super.requeue(...args);
  }

  override isAvailable(): boolean {
    return this.available;
  }

  override async ingest(...args: Parameters<RedisMetadataOperationBuffer["ingest"]>) {
    if (this.rejectIngest) throw new Error("NOSCRIPT or OOM");
    await super.ingest(...args);
    if (this.loseNextReply) {
      this.loseNextReply = false;
      throw new Error("reply lost");
    }
  }
}

class LostIngestReplyBuffer extends RedisMetadataOperationBuffer {
  private replied = false;

  override isAvailable(): boolean {
    return true;
  }

  override async ingest(...args: Parameters<RedisMetadataOperationBuffer["ingest"]>) {
    await super.ingest(...args);
    if (!this.replied) {
      this.replied = true;
      throw new Error("reply lost");
    }
  }
}

class ConnectedFailingRedisBuffer extends RedisMetadataOperationBuffer {
  override isAvailable(): boolean {
    return true;
  }

  override async ingest(): Promise<void> {
    throw new Error("connection lost mid-command");
  }
}

class UnavailableRedisBuffer extends RedisMetadataOperationBuffer {
  ingestCalls = 0;

  override isAvailable(): boolean {
    return false;
  }

  override async ingest(): Promise<void> {
    this.ingestCalls++;
    throw new Error("redis unavailable");
  }

  override async claimDue(): Promise<never[]> {
    throw new Error("redis unavailable");
  }
}

class UnreliableWriteRunStore extends PostgresRunStore {
  failNextWrite:
    | "pool-timeout"
    | "before-commit"
    | "after-commit"
    | "connection-lost-after-commit"
    | undefined;
  failNextWriteFor: string | undefined;
  writeAttempts = 0;

  override async updateMetadata(...args: Parameters<PostgresRunStore["updateMetadata"]>) {
    this.writeAttempts++;
    if (this.failNextWriteFor === args[0]) {
      this.failNextWriteFor = undefined;
      this.failNextWrite = "before-commit";
    }
    const mode = this.failNextWrite;
    this.failNextWrite = undefined;
    if (mode === "pool-timeout") {
      throw Object.assign(
        new Error("Timed out fetching a new connection from the connection pool."),
        { name: "PrismaClientKnownRequestError", code: "P2024" }
      );
    }
    if (mode === "before-commit") throw new Error("connection reset before commit");
    const result = await super.updateMetadata(...args);
    if (mode === "after-commit") throw new Error("connection reset after commit");
    if (mode === "connection-lost-after-commit") {
      throw Object.assign(new Error("Can't reach database server"), {
        name: "PrismaClientKnownRequestError",
        code: "P1001",
      });
    }
    return result;
  }
}

class LostAckBuffer extends RedisMetadataOperationBuffer {
  lostAcks = 0;

  override async ack(): Promise<void> {
    this.lostAcks++;
    throw new Error("redis unavailable");
  }
}

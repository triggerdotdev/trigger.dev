import { ClickHouse, type MetricsV1Input } from "@internal/clickhouse";
import { Redis } from "@internal/redis";
import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { containerTestWithClickhouse } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import {
  insertByOrganization,
  pickEnvironments,
  rowsFor,
  runTick,
  slotFor,
  type QueueSizeMetricsSamplerDeps,
  type QueueSizeMetricsSamplerOptions,
} from "~/v3/services/queueSizeMetricsSampler.server";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

async function createSecondEnvironment(prisma: PrismaClient, workerGroupId: string) {
  const org = await prisma.organization.create({
    data: { title: "Unlimited Org", slug: "unlimited-org" },
  });
  const project = await prisma.project.create({
    data: {
      name: "Unlimited Project",
      slug: "unlimited-project",
      externalRef: "proj_unlimited",
      organizationId: org.id,
      defaultWorkerGroupId: workerGroupId,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: "prod",
      projectId: project.id,
      organizationId: org.id,
      apiKey: "api_key_unlimited",
      pkApiKey: "pk_api_key_unlimited",
      shortcode: "short_unlimited",
      maximumConcurrencyLimit: 10,
    },
  });
  return prisma.runtimeEnvironment.findUniqueOrThrow({
    where: { id: environment.id },
    include: { project: true, organization: true, orgMember: true },
  });
}

const MetricRow = z.object({
  environment_id: z.string(),
  metric_name: z.string(),
  bucket_start: z.string(),
  value: z.number(),
});

function bucketOf(at: Date) {
  return new Date(Math.floor(at.getTime() / 10_000) * 10_000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

describe("queue size metrics sampler", () => {
  it("picks alert-bound environments first, caps them, and writes a limit row only when limited", () => {
    expect(pickEnvironments(["env_alert"], ["env_a", "env_alert", "env_b"], 2)).toEqual([
      "env_alert",
      "env_a",
    ]);
    const environment = { id: "env_1", projectId: "proj_1", organizationId: "org_1" };
    expect(rowsFor(environment, 3, null, "b").map((row) => row.metric_name)).toEqual([
      "queue.size.queued",
    ]);
    expect(rowsFor(environment, 3, 100, "b").map((row) => [row.metric_name, row.value])).toEqual([
      ["queue.size.queued", 3],
      ["queue.size.limit", 100],
    ]);
    const slotStart = new Date(Math.floor(Date.now() / 30_000) * 30_000);
    expect(slotFor(new Date(slotStart.getTime() + 29_000), 30)).toBe(slotFor(slotStart, 30));
    expect(slotFor(new Date(slotStart.getTime() + 30_000), 30)).toBe(slotFor(slotStart, 30) + 1);
  });

  containerTestWithClickhouse(
    "a Limits alert selecting the queue component binds its environment",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const redis = new Redis(redisOptions);
      onTestFinished(async () => {
        await redis.quit();
      });
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "queue-size-sampler-health-all",
      });
      onTestFinished(() => clickhouse.close());

      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await prisma.alert.create({
        data: {
          id: "alert_health_all",
          organizationId: env.organizationId,
          projectId: env.projectId,
          environmentId: env.id,
          capabilityKey: "limits.all",
          params: {},
          condition: { kind: "state", stateKey: "limits.all", components: ["limits.queue"] },
          createdBy: "test",
        },
      });

      const result = await runTick(
        { now: new Date() },
        { intervalSec: 30, maxEnvs: 10 },
        {
          replica: prisma,
          redis,
          clickhouse,
          lengthOfEnvQueue: async () => 1,
          insert: insertByOrganization(() => clickhouse),
        }
      );
      expect(result).toMatchObject({ status: "sampled", environments: 1 });
    }
  );

  containerTestWithClickhouse(
    "samples active environments once per slot, alert-bound first, and survives failed reads and writes",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const redis = new Redis(redisOptions);
      onTestFinished(async () => {
        await redis.quit();
      });
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "queue-size-sampler-test",
      });
      onTestFinished(() => clickhouse.close());

      const limited = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await prisma.organization.update({
        where: { id: limited.organizationId },
        data: { maximumDeployedQueueSize: 100 },
      });
      const unlimited = await createSecondEnvironment(
        prisma,
        limited.project.defaultWorkerGroupId!
      );
      const queued = new Map([
        [limited.id, 2],
        [unlimited.id, 1],
      ]);
      const lengthOfEnvQueue: QueueSizeMetricsSamplerDeps["lengthOfEnvQueue"] = async (env) =>
        queued.get(env.id) ?? 0;
      const [seedError] = await clickhouse.writer.insert({
        name: "seedEnvMetrics",
        table: "trigger_dev.env_metrics_v1",
        schema: z.any(),
        settings: { async_insert: 0 },
      })([
        {
          organization_id: limited.organizationId,
          project_id: limited.projectId,
          environment_id: limited.id,
          bucket_start: Math.floor(Date.now() / 1000),
          max_env_queued: 1,
        },
      ]);
      expect(seedError).toBeNull();
      await prisma.alert.create({
        data: {
          id: "alert_queue_size",
          organizationId: unlimited.organizationId,
          projectId: unlimited.projectId,
          environmentId: unlimited.id,
          capabilityKey: "limits.queue.size",
          params: {},
          condition: {},
          createdBy: "test",
        },
      });

      const sample = (
        at: Date,
        options: Partial<QueueSizeMetricsSamplerOptions> = {},
        deps: Partial<QueueSizeMetricsSamplerDeps> = {}
      ) =>
        runTick(
          { now: at },
          { intervalSec: 30, maxEnvs: 10, ...options },
          {
            replica: prisma,
            redis,
            clickhouse,
            lengthOfEnvQueue,
            insert: insertByOrganization(() => clickhouse),
            ...deps,
          }
        );
      const rowsAt = async (at: Date) => {
        const [error, rows] = await clickhouse.reader.query({
          name: "queue-size-rows",
          query:
            "SELECT environment_id, metric_name, toString(bucket_start) AS bucket_start, value FROM trigger_dev.metrics_v1",
          schema: MetricRow,
        })({});
        expect(error).toBeNull();
        return rows!
          .filter((row) => row.bucket_start === bucketOf(at))
          .map((row) => [row.environment_id, row.metric_name, row.value]);
      };

      const slot0 = new Date(Math.floor(Date.now() / 30_000) * 30_000);
      const slot1 = new Date(slot0.getTime() + 30_000);
      const slot2 = new Date(slot0.getTime() + 60_000);

      const results = await Promise.all([sample(slot0), sample(slot0)]);
      expect(results.map((r) => r.status).sort()).toEqual(["locked", "sampled"]);
      expect(results.find((r) => r.status === "sampled")).toEqual({
        status: "sampled",
        environments: 2,
        rows: 3,
      });
      expect((await rowsAt(slot0)).sort()).toEqual(
        [
          [limited.id, "queue.size.queued", 2],
          [limited.id, "queue.size.limit", 100],
          [unlimited.id, "queue.size.queued", 1],
        ].sort()
      );
      expect(await sample(new Date(slot0.getTime() + 29_000))).toEqual({ status: "locked" });
      expect(await sample(slot1)).toMatchObject({ status: "sampled", environments: 2 });

      expect(await sample(slot2, { maxEnvs: 1 })).toMatchObject({ environments: 1 });
      expect(await rowsAt(slot2)).toEqual([[unlimited.id, "queue.size.queued", 1]]);

      const slot3 = new Date(slot0.getTime() + 90_000);
      await expect(
        sample(slot3, {}, { insert: () => Promise.reject(new Error("clickhouse down")) })
      ).rejects.toThrow("clickhouse down");
      expect(await sample(slot3)).toMatchObject({ status: "sampled", rows: 3 });

      const slot4 = new Date(slot0.getTime() + 120_000);
      const result = await sample(
        slot4,
        {},
        {
          lengthOfEnvQueue: (env) =>
            env.id === limited.id ? Promise.reject(new Error("redis down")) : lengthOfEnvQueue(env),
        }
      );
      expect(result).toMatchObject({ status: "sampled", environments: 2, rows: 1 });
      expect(await rowsAt(slot4)).toEqual([[unlimited.id, "queue.size.queued", 1]]);

      const slot5 = new Date(slot0.getTime() + 150_000);
      const shardDown = new ClickHouse({
        url: "http://default:password@127.0.0.1:1",
        name: "unreachable",
        requestTimeoutMs: 1_000,
      });
      onTestFinished(() => shardDown.close());
      const partial = await sample(
        slot5,
        {},
        {
          insert: insertByOrganization((organizationId) =>
            organizationId === limited.organizationId ? shardDown : clickhouse
          ),
        }
      );
      expect(partial).toMatchObject({ status: "sampled", rows: 1 });
      expect(await rowsAt(slot5)).toEqual([[unlimited.id, "queue.size.queued", 1]]);
      expect(await sample(slot5)).toEqual({ status: "locked" });

      const slot6 = new Date(slot0.getTime() + 180_000);
      const lockKey = `metrics:queue-size:sampler:${slotFor(slot6, 30)}`;
      await expect(
        sample(
          slot6,
          {},
          {
            insert: async () => {
              await redis.set(lockKey, "another-sampler");
              throw new Error("clickhouse down");
            },
          }
        )
      ).rejects.toThrow("clickhouse down");
      expect(await redis.get(lockKey)).toBe("another-sampler");
    }
  );

  containerTestWithClickhouse(
    "reads queue length from the run engine",
    async ({ prisma, redisOptions, clickhouseContainer }) => {
      const engine = new RunEngine({
        prisma,
        worker: { disabled: true, redis: redisOptions, workers: 1, tasksPerWorker: 10 },
        queue: {
          redis: redisOptions,
          masterQueueConsumersDisabled: true,
          ttlSystem: { disabled: true },
        },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });
      onTestFinished(() => engine.quit());
      const redis = new Redis(redisOptions);
      onTestFinished(async () => {
        await redis.quit();
      });
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "queue-size-sampler-engine-test",
      });
      onTestFinished(() => clickhouse.close());

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await setupBackgroundWorker(engine, environment, "sampled-task");
      await engine.trigger(
        {
          number: 1,
          friendlyId: generateFriendlyId("run"),
          environment,
          taskIdentifier: "sampled-task",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          workerQueue: "main",
          queue: "task/sampled-task",
          isTest: false,
          tags: [],
        },
        prisma
      );
      await prisma.alert.create({
        data: {
          id: "alert_engine_queue",
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          environmentId: environment.id,
          capabilityKey: "limits.queue.size",
          params: {},
          condition: {},
          createdBy: "test",
        },
      });

      const rows: MetricsV1Input[] = [];
      const result = await runTick(
        { now: new Date() },
        { intervalSec: 30, maxEnvs: 10 },
        {
          replica: prisma,
          redis,
          clickhouse,
          lengthOfEnvQueue: (env) => engine.lengthOfEnvQueue(env),
          insert: async (batch) => {
            rows.push(...batch);
            return batch.length;
          },
        }
      );

      expect(result).toMatchObject({ status: "sampled", environments: 1 });
      expect(rows.find((row) => row.metric_name === "queue.size.queued")?.value).toBe(1);
    }
  );
});

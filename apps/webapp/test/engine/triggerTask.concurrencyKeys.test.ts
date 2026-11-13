import { describe, expect, onTestFinished, vi } from "vitest";
import { RunEngine } from "@internal/run-engine";
import type { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function setup(prisma: PrismaClient, redisOptions: RedisOptions) {
  const engine = new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
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

  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const taskIdentifier = "test-task";
  await setupBackgroundWorker(engine, environment, taskIdentifier);
  await prisma.backgroundWorkerTask.updateMany({
    where: { slug: taskIdentifier, runtimeEnvironmentId: environment.id },
    data: { gates: [{ queue: "limit/org" }, { queue: "limit/region" }] },
  });

  const triggerTaskService = new RunEngineTriggerTaskService({
    engine,
    prisma,
    payloadProcessor: new MockPayloadProcessor(),
    queueConcern: new DefaultQueueManager(prisma, engine),
    idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
    validator: new MockTriggerTaskValidator(),
    traceEventConcern: new MockTraceEventConcern(),
    tracer: trace.getTracer("test", "0.0.0"),
    metadataMaximumSize: 1024 * 1024,
  });

  const trigger = async (options: NonNullable<TriggerTaskRequestBody["options"]>) => {
    const result = await triggerTaskService.call({
      taskId: taskIdentifier,
      environment,
      body: { payload: {}, options },
    });
    const run = await prisma.taskRun.findFirst({ where: { id: result?.run.id } });
    assertNonNullable(run);
    return run;
  };

  return { taskIdentifier, trigger };
}

const keysOf = (run: { concurrencyKey: string | null; gates: unknown }) => ({
  concurrencyKey: run.concurrencyKey,
  gates: run.gates,
});

describe("RunEngineTriggerTaskService concurrency keys per limit", () => {
  // Catches: a named limit keyed by the default key, or an entry for an undeclared limit rejected or replacing declared ones.
  containerTest(
    "keys each named limit by its own entry, adding the limit when the task does not declare it",
    async ({ prisma, redisOptions }) => {
      const { taskIdentifier, trigger } = await setup(prisma, redisOptions);

      expect(
        keysOf(await trigger({ concurrencyKey: { default: "session-1", org: "org-1" } }))
      ).toEqual({
        concurrencyKey: "session-1",
        gates: [{ queue: "limit/org", concurrencyKey: "org-1" }, { queue: "limit/region" }],
      });

      expect(
        keysOf(
          await trigger({
            concurrencyKey: { default: "session-1", priority: "org-1" },
            concurrency: ["priority"],
          })
        )
      ).toEqual({
        concurrencyKey: "session-1",
        gates: [{ queue: "limit/priority", concurrencyKey: "org-1" }],
      });

      expect(keysOf(await trigger({ concurrencyKey: "session-1" }))).toEqual({
        concurrencyKey: "session-1",
        gates: [{ queue: "limit/org" }, { queue: "limit/region" }],
      });

      expect(
        keysOf(await trigger({ concurrencyKey: { default: "session-1", tier: "org-1" } }))
      ).toEqual({
        concurrencyKey: "session-1",
        gates: [
          { queue: "limit/org" },
          { queue: "limit/region" },
          { queue: "limit/tier", concurrencyKey: "org-1" },
        ],
      });

      expect(
        keysOf(
          await trigger({
            concurrencyKey: { default: "session-1", tier: "org-1" },
            concurrency: ["priority"],
          })
        )
      ).toEqual({
        concurrencyKey: "session-1",
        gates: [{ queue: "limit/priority" }, { queue: "limit/tier", concurrencyKey: "org-1" }],
      });

      await expect(
        trigger({ concurrencyKey: { default: "session-1", [`task/${taskIdentifier}`]: "org-1" } })
      ).rejects.toThrow("Invalid concurrencyKey entry");
    }
  );

  // Catches: a replay-shaped trigger losing or re-keying the per-limit keys (the replay service itself is not run).
  containerTest(
    "a replay-shaped trigger keeps each named limit's key and only changes the run's own",
    async ({ prisma, redisOptions }) => {
      const { trigger } = await setup(prisma, redisOptions);
      const original = await trigger({ concurrencyKey: { default: "session-1", org: "org-1" } });
      const gates = [{ queue: "limit/org", concurrencyKey: "org-1" }, { queue: "limit/region" }];
      expect(original.gates).toEqual(gates);

      const replay = async (concurrencyKeyOverride?: string) =>
        keysOf(
          await trigger({
            queue: { name: original.queue },
            concurrencyKey: concurrencyKeyOverride ?? original.concurrencyKey ?? undefined,
            gates: original.gates as Array<{ queue: string; concurrencyKey?: string }>,
          })
        );

      expect(await replay()).toEqual({ concurrencyKey: "session-1", gates });
      expect(await replay("session-2")).toEqual({ concurrencyKey: "session-2", gates });
    }
  );
});

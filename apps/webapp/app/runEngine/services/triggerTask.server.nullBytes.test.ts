import { describe, expect, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));
vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));
vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "./triggerTask.server";
import {
  buildEngine,
  CapturingParentRunValidator,
  MockPayloadProcessor,
  MockTraceEventConcern,
} from "./triggerTask.server.test.helpers";

vi.setConfig({ testTimeout: 60_000 });

const NUL = String.fromCharCode(0);

function buildService(engine: any, prisma: any) {
  return new RunEngineTriggerTaskService({
    engine,
    prisma,
    payloadProcessor: new MockPayloadProcessor(),
    queueConcern: new DefaultQueueManager(prisma, engine),
    idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
    validator: new CapturingParentRunValidator(),
    traceEventConcern: new MockTraceEventConcern(),
    tracer: trace.getTracer("test", "0.0.0"),
    metadataMaximumSize: 1024 * 1024 * 1,
  });
}

describe("RunEngineTriggerTaskService null-byte sanitization", () => {
  containerTest(
    "strips a NUL from idempotencyKeyOptions.key so the jsonb insert does not 22P05",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const service = buildService(engine, prisma);

        const result = await service.call({
          taskId: "nul-idem-task",
          environment,
          body: {
            payload: { kind: "idem" },
            options: {
              idempotencyKey: "a".repeat(64),
              idempotencyKeyOptions: { key: `acme${NUL}inc`, scope: "run" },
            },
          },
        });
        assertNonNullable(result);

        const row = await prisma.taskRun.findUniqueOrThrow({ where: { id: result.run.id } });
        expect(row.idempotencyKeyOptions).toEqual({ key: "acmeinc", scope: "run" });
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "strips a NUL from debounce.key so the jsonb insert does not 22P05",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const service = buildService(engine, prisma);

        const result = await service.call({
          taskId: "nul-debounce-task",
          environment,
          body: {
            payload: { kind: "debounce" },
            options: {
              debounce: { key: `grp${NUL}1`, delay: "1s" },
            },
          },
        });
        assertNonNullable(result);

        const row = await prisma.taskRun.findUniqueOrThrow({ where: { id: result.run.id } });
        expect((row.debounce as { key: string }).key).toBe("grp1");
      } finally {
        await engine.quit();
      }
    }
  );
});

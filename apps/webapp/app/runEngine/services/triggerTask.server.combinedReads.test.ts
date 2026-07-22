// Split from triggerTask.server.test.ts (combined parent + locked-worker read)
// so CI's duration-based sharding can balance the container-heavy tests.
import { describe, expect, vi } from "vitest";

// Mock the db prisma client. The service is constructed against a real
// testcontainer prisma instead — these empty singletons only satisfy the
// module-level imports of the production wiring (infrastructure boundary).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
  runOpsNewReplica: {},
  runOpsLegacyReplica: {},
}));
// Inherited harness boilerplate. The parent read under test takes the
// findRun(where, client) overload with this.prisma, so it does not consult this
// flag; the mock only satisfies other wiring imported transitively.
vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
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

vi.setConfig({ testTimeout: 60_000 }); // 60 seconds timeout

describe("RunEngineTriggerTaskService combined parent + locked-worker reads", () => {
  containerTest(
    "issues two independent single-table reads when one call supplies both parentRunId and lockToVersion",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        const { worker } = await setupBackgroundWorker(engine, environment, taskIdentifier);

        const workerRow = await prisma.backgroundWorker.findUniqueOrThrow({
          where: { id: worker.id },
        });

        // Count BOTH reads issued by the service on the control-plane client:
        // the parent read (runStore.findRun → taskRun.findFirst) and the
        // locked-worker read (backgroundWorker.findFirst). Capture every
        // findFirst arg so we can assert no read carries a cross-seam include.
        let taskRunFindFirstCalls = 0;
        let backgroundWorkerFindFirstCalls = 0;
        const findFirstArgs: any[] = [];
        const countingPrisma = new Proxy(prisma, {
          get(target, prop, receiver) {
            if (prop === "backgroundWorker") {
              const delegate = Reflect.get(target, prop, receiver);
              return new Proxy(delegate, {
                get(bwTarget, bwProp, bwReceiver) {
                  if (bwProp === "findFirst") {
                    return async (args: any) => {
                      backgroundWorkerFindFirstCalls += 1;
                      findFirstArgs.push(args);
                      return (delegate as any).findFirst(args);
                    };
                  }
                  const value = Reflect.get(bwTarget, bwProp, bwReceiver);
                  return typeof value === "function" ? value.bind(bwTarget) : value;
                },
              });
            }
            if (prop === "taskRun") {
              const delegate = Reflect.get(target, prop, receiver);
              return new Proxy(delegate, {
                get(trTarget, trProp, trReceiver) {
                  if (trProp === "findFirst") {
                    return async (args: any) => {
                      taskRunFindFirstCalls += 1;
                      findFirstArgs.push(args);
                      return (delegate as any).findFirst(args);
                    };
                  }
                  const value = Reflect.get(trTarget, trProp, trReceiver);
                  return typeof value === "function" ? value.bind(trTarget) : value;
                },
              });
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as typeof prisma;

        const triggerTaskService = new RunEngineTriggerTaskService({
          engine,
          prisma: countingPrisma,
          payloadProcessor: new MockPayloadProcessor(),
          // queueConcern/idempotency get the real unproxied prisma so the
          // counting proxy only observes reads issued by the service itself.
          queueConcern: new DefaultQueueManager(prisma, engine),
          idempotencyKeyConcern: new IdempotencyKeyConcern(
            prisma,
            engine,
            new MockTraceEventConcern()
          ),
          validator: new CapturingParentRunValidator(),
          traceEventConcern: new MockTraceEventConcern(),
          tracer: trace.getTracer("test", "0.0.0"),
          metadataMaximumSize: 1024 * 1024 * 1,
        });

        // ROOT parent first (uses the unproxied prisma via a separate service so
        // its internal reads don't pollute the child's counts).
        const parentService = new RunEngineTriggerTaskService({
          engine,
          prisma,
          payloadProcessor: new MockPayloadProcessor(),
          queueConcern: new DefaultQueueManager(prisma, engine),
          idempotencyKeyConcern: new IdempotencyKeyConcern(
            prisma,
            engine,
            new MockTraceEventConcern()
          ),
          validator: new CapturingParentRunValidator(),
          traceEventConcern: new MockTraceEventConcern(),
          tracer: trace.getTracer("test", "0.0.0"),
          metadataMaximumSize: 1024 * 1024 * 1,
        });
        const parentResult = await parentService.call({
          taskId: taskIdentifier,
          environment,
          body: { payload: { kind: "parent" } },
        });
        assertNonNullable(parentResult);

        // CHILD supplying BOTH parentRunId AND lockToVersion in one call.
        const childResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment,
          body: {
            payload: { kind: "child" },
            options: {
              parentRunId: parentResult.run.friendlyId,
              lockToVersion: workerRow.version,
            },
          },
        });
        assertNonNullable(childResult);

        const parentRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: parentResult.run.id },
        });
        const childRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: childResult.run.id },
        });

        // Child resolved the parent (single-table parent read).
        expect(childRow.parentTaskRunId).toBe(parentRow.id);
        expect(childRow.depth).toBe(parentRow.depth + 1);

        // Child locked to the worker (single-table worker read).
        expect(childRow.lockedToVersionId).toBe(workerRow.id);
        expect(childRow.taskVersion).toBe(workerRow.version);

        // Exactly one backgroundWorker.findFirst fired for the locked-worker read,
        // and at least one taskRun.findFirst fired for the parent read.
        expect(backgroundWorkerFindFirstCalls).toBe(1);
        expect(taskRunFindFirstCalls).toBeGreaterThanOrEqual(1);

        // NO-JOIN proof: no captured read carried an `include` joining
        // taskRun <-> backgroundWorker. Every findFirst arg has include undefined.
        for (const args of findFirstArgs) {
          expect(args?.include).toBeUndefined();
        }
      } finally {
        await engine.quit();
      }
    }
  );
});

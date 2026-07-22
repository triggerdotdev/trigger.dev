// Split from triggerTask.server.test.ts (locked-worker read concerns) so CI's
// duration-based sharding can balance the container-heavy tests.
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

describe("RunEngineTriggerTaskService locked-worker reads", () => {
  containerTest(
    "resolves the locked background worker on the control-plane client with no cross-DB join",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        const { worker } = await setupBackgroundWorker(engine, environment, taskIdentifier);

        // Read the seeded worker row to get its real version/id.
        const workerRow = await prisma.backgroundWorker.findUniqueOrThrow({
          where: { id: worker.id },
        });

        // Counting proxy over the control-plane client. `this.prisma` is ALWAYS
        // the control-plane client; the locked-worker lookup is a DIRECT
        // backgroundWorker.findFirst on it. The parent read uses a DIFFERENT
        // call (runStore.findRun → taskRun), so a single call() issues two
        // separate single-table reads — never one cross-seam join. Here we count
        // the findFirst calls and capture their args to assert no include/join.
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
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as typeof prisma;

        const triggerTaskService = new RunEngineTriggerTaskService({
          engine,
          prisma: countingPrisma,
          payloadProcessor: new MockPayloadProcessor(),
          // The queue manager gets the real (unproxied) prisma so the counting
          // proxy only observes reads issued by the service itself.
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

        const result = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment,
          body: {
            payload: { kind: "locked" },
            options: { lockToVersion: workerRow.version },
          },
        });
        assertNonNullable(result);

        // Observable proof the locked worker was resolved on the control-plane
        // client: the created run records the worker id in lockedToVersionId.
        const runRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: result.run.id },
        });
        expect(runRow.lockedToVersionId).toBe(workerRow.id);
        expect(runRow.taskVersion).toBe(workerRow.version);

        // Exactly one backgroundWorker.findFirst fired for the locked-worker read.
        expect(backgroundWorkerFindFirstCalls).toBe(1);

        // NO-JOIN assertion: the read referenced ONLY the backgroundWorker table.
        // No `include` (which would join into another table); the `select` lists
        // only backgroundWorker scalar columns.
        const args = findFirstArgs[0];
        assertNonNullable(args);
        expect(args.include).toBeUndefined();
        expect(Object.keys(args.select ?? {}).sort()).toEqual([
          "cliVersion",
          "id",
          "sdkVersion",
          "version",
        ]);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "lockToVersion matching no worker rejects the trigger after a single scalar-only worker read",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

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
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as typeof prisma;

        const triggerTaskService = new RunEngineTriggerTaskService({
          engine,
          prisma: countingPrisma,
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

        const bogusVersion = "v-does-not-exist-0000";
        // The no-match worker read returns null; the queue concern then rejects
        // the trigger rather than silently locking the run to a phantom version.
        await expect(
          triggerTaskService.call({
            taskId: taskIdentifier,
            environment,
            body: {
              payload: { kind: "locked" },
              options: { lockToVersion: bogusVersion },
            },
          })
        ).rejects.toThrow(/no worker found with that version/);

        // No run was locked to the bogus version (none was created).
        const lockedRuns = await prisma.taskRun.findMany({
          where: { runtimeEnvironmentId: environment.id, taskVersion: bogusVersion },
        });
        expect(lockedRuns).toEqual([]);

        // The lone worker read fired exactly once with the scalar-only select and
        // no cross-seam include.
        expect(backgroundWorkerFindFirstCalls).toBe(1);
        const args = findFirstArgs[0];
        assertNonNullable(args);
        expect(args.include).toBeUndefined();
        expect(Object.keys(args.select ?? {}).sort()).toEqual([
          "cliVersion",
          "id",
          "sdkVersion",
          "version",
        ]);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "does not resolve a locked worker from a different environment",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        // Two independent authenticated environments. Rename envA's globally-unique
        // fields before the second setup call to avoid unique-constraint collisions.
        const envA = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await prisma.organization.update({
          where: { id: envA.organizationId },
          data: { slug: `${envA.organization.slug}-a` },
        });
        await prisma.project.update({
          where: { id: envA.projectId },
          data: { slug: `${envA.project.slug}-a`, externalRef: `${envA.project.externalRef}-a` },
        });
        await prisma.runtimeEnvironment.update({
          where: { id: envA.id },
          data: { apiKey: `${envA.apiKey}-a`, pkApiKey: `${envA.pkApiKey}-a` },
        });
        await prisma.workerGroupToken.updateMany({
          where: { tokenHash: "token_hash" },
          data: { tokenHash: "token_hash_a" },
        });
        await prisma.workerInstanceGroup.updateMany({
          where: { masterQueue: "default" },
          data: { masterQueue: "default_a" },
        });
        const envB = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        expect(envA.id).not.toBe(envB.id);
        expect(envA.organizationId).not.toBe(envB.organizationId);

        const taskIdentifier = "test-task";
        const { worker: workerA } = await setupBackgroundWorker(engine, envA, taskIdentifier);
        const { worker: workerB } = await setupBackgroundWorker(engine, envB, taskIdentifier);

        const workerARow = await prisma.backgroundWorker.findUniqueOrThrow({
          where: { id: workerA.id },
        });
        const workerBRow = await prisma.backgroundWorker.findUniqueOrThrow({
          where: { id: workerB.id },
        });
        // Both seeded workers share the same version string.
        expect(workerARow.version).toBe(workerBRow.version);
        expect(workerARow.id).not.toBe(workerBRow.id);

        const triggerTaskService = new RunEngineTriggerTaskService({
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

        // Trigger in envB locking to the shared version string.
        const result = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment: envB,
          body: {
            payload: { kind: "locked" },
            options: { lockToVersion: workerBRow.version },
          },
        });
        assertNonNullable(result);

        const runRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: result.run.id },
        });
        // The projectId + runtimeEnvironmentId guard in the single-table worker
        // read resolves envB's worker, never envA's same-version worker.
        expect(runRow.lockedToVersionId).toBe(workerBRow.id);
        expect(runRow.lockedToVersionId).not.toBe(workerARow.id);
        expect(runRow.taskVersion).toBe(workerBRow.version);
      } finally {
        await engine.quit();
      }
    }
  );
});

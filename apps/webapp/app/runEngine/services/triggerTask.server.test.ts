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

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import type { IOPacket } from "@trigger.dev/core/v3";
import type { TaskRun } from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import type {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  PayloadProcessor,
  TagValidationParams,
  TracedEventSpan,
  TraceEventConcern,
  TriggerTaskRequest,
  TriggerTaskValidator,
  ValidationResult,
} from "~/runEngine/types";
import { RunEngineTriggerTaskService } from "./triggerTask.server";

vi.setConfig({ testTimeout: 60_000 }); // 60 seconds timeout

class MockPayloadProcessor implements PayloadProcessor {
  async process(request: TriggerTaskRequest): Promise<IOPacket> {
    return {
      data: JSON.stringify(request.body.payload),
      dataType: "application/json",
    };
  }
}

// Captures the `parentRun` the service resolved (via runStore.findRun) and
// passed into validation, so a test can assert on the resolved parent without
// mocking the read itself. Returns ok so the child triggers regardless.
class CapturingParentRunValidator implements TriggerTaskValidator {
  public capturedParentRun: ParentRunValidationParams["parentRun"] | "unset" = "unset";

  validateTags(_params: TagValidationParams): ValidationResult {
    return { ok: true };
  }
  validateEntitlement(_params: EntitlementValidationParams): Promise<ValidationResult> {
    return Promise.resolve({ ok: true });
  }
  validateMaxAttempts(_params: MaxAttemptsValidationParams): ValidationResult {
    return { ok: true };
  }
  validateParentRun(params: ParentRunValidationParams): ValidationResult {
    this.capturedParentRun = params.parentRun;
    return { ok: true };
  }
}

class MockTraceEventConcern implements TraceEventConcern {
  async traceRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }

  async traceIdempotentRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    _options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }

  async traceDebouncedRun<T>(
    _request: TriggerTaskRequest,
    _parentStore: string | undefined,
    _options: {
      existingRun: TaskRun;
      debounceKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => {},
        failWithError: () => {},
        stop: () => {},
      },
      "test"
    );
  }
}

function buildEngine(prisma: any, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

describe("RunEngineTriggerTaskService parent + locked-worker reads", () => {
  containerTest(
    "resolves the parent run through the run-ops store by minted run id",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const validator = new CapturingParentRunValidator();
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
          validator,
          traceEventConcern: new MockTraceEventConcern(),
          tracer: trace.getTracer("test", "0.0.0"),
          metadataMaximumSize: 1024 * 1024 * 1,
        });

        // Trigger a ROOT run first to create a real parent TaskRun.
        const parentResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment,
          body: { payload: { kind: "parent" } },
        });
        assertNonNullable(parentResult);

        // Trigger a CHILD pointing at the parent's friendlyId. The service must
        // resolve the parent via runStore.findRun (minted RunId, env-scoped).
        const childResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment,
          body: {
            payload: { kind: "child" },
            options: { parentRunId: parentResult.run.friendlyId },
          },
        });
        assertNonNullable(childResult);

        // The capturing validator observed the resolved parent — proving the
        // read ran (against the container DB) and returned the right row.
        expect(validator.capturedParentRun).not.toBe("unset");
        const capturedParent = validator.capturedParentRun;
        assertNonNullable(capturedParent);
        expect(capturedParent.id).toBe(parentResult.run.id);
        expect(capturedParent.friendlyId).toBe(parentResult.run.friendlyId);

        // depth and root carry through — proving parentRun.depth and the parent
        // id were read off the resolved row and threaded into the child.
        const parentRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: parentResult.run.id },
        });
        const childRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: childResult.run.id },
        });

        expect(childRow.depth).toBe(parentRow.depth + 1);
        expect(childRow.parentTaskRunId).toBe(parentRow.id);
        expect(childRow.rootTaskRunId).toBe(parentRow.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "scopes the parent lookup to the run's environment (cross-env parent is not resolved)",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);

      try {
        // Two independent authenticated environments. The setup helper hardcodes
        // several globally-unique fields (org/project slug, env apiKey/pkApiKey,
        // worker-group token hash), so rename envA's before the second call to
        // avoid unique-constraint collisions.
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
        await setupBackgroundWorker(engine, envA, taskIdentifier);
        await setupBackgroundWorker(engine, envB, taskIdentifier);

        const validator = new CapturingParentRunValidator();
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
          validator,
          traceEventConcern: new MockTraceEventConcern(),
          tracer: trace.getTracer("test", "0.0.0"),
          metadataMaximumSize: 1024 * 1024 * 1,
        });

        // A real parent run in envA.
        const parentResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment: envA,
          body: { payload: { kind: "parent" } },
        });
        assertNonNullable(parentResult);

        // Trigger a child in envB pointing at the envA parent's friendlyId. The
        // env guard in runStore.findRun's `where` rejects the cross-env parent
        // in a single query, so the resolved parentRun is null.
        const childResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment: envB,
          body: {
            payload: { kind: "child" },
            options: { parentRunId: parentResult.run.friendlyId },
          },
        });
        assertNonNullable(childResult);

        // validateParentRun was called with no resolved parent.
        expect(validator.capturedParentRun).not.toBe("unset");
        expect(validator.capturedParentRun ?? null).toBeNull();

        // The child still triggered, at the root depth with no parent linkage —
        // confirming the cross-env parent was dropped, not silently joined.
        const childRow = await prisma.taskRun.findUniqueOrThrow({
          where: { id: childResult.run.id },
        });
        expect(childRow.depth).toBe(0);
        expect(childRow.parentTaskRunId).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

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

  containerTest("a root trigger issues no parent lookup", async ({ prisma, redisOptions }) => {
    const engine = buildEngine(prisma, redisOptions);

    try {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const validator = new CapturingParentRunValidator();
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
        validator,
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1,
      });

      // Trigger with NO parentRunId.
      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { kind: "root" } },
      });
      assertNonNullable(result);

      // The validator ran but received no resolved parent: the parent read was
      // skipped because no parentRunId was supplied.
      expect(validator.capturedParentRun).not.toBe("unset");
      expect(validator.capturedParentRun).toBeUndefined();

      const runRow = await prisma.taskRun.findUniqueOrThrow({
        where: { id: result.run.id },
      });
      expect(runRow.depth).toBe(0);
      expect(runRow.parentTaskRunId).toBeNull();
    } finally {
      await engine.quit();
    }
  });
});

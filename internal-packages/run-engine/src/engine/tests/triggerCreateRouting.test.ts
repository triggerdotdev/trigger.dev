import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  PostgresRunStore,
  RoutingRunStore,
  type CreateCancelledRunInput,
  type CreateFailedRunInput,
  type CreateRunInput,
} from "@internal/run-store";
import { RunId, ownerEngine, generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import type { ControlPlaneResolver } from "../controlPlaneResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function baseEngineOptions(redisOptions: any) {
  return {
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

/**
 * A real `PostgresRunStore` that records each create/find call and the client
 * arg it received. NOT a mock — every method still issues the real query via
 * `super.*`; it only counts and records the forwarded tx/client arg so the tests
 * can prove routing (which store ran) and the tx-arg residency fix (what client
 * the create forwarded).
 */
class CountingRunStore extends PostgresRunStore {
  label: string;
  createRunCalls = 0;
  createCancelledRunCalls = 0;
  createFailedRunCalls = 0;
  findRunCalls = 0;
  createRunTxArgs: (PrismaClientOrTransaction | undefined)[] = [];
  createCancelledRunTxArgs: (PrismaClientOrTransaction | undefined)[] = [];
  createFailedRunTxArgs: (PrismaClientOrTransaction | undefined)[] = [];

  constructor(opts: { prisma: any; readOnlyPrisma: any; label?: string }) {
    super({ prisma: opts.prisma, readOnlyPrisma: opts.readOnlyPrisma });
    this.label = opts.label ?? "counting";
  }

  override createRun(p: CreateRunInput, tx?: PrismaClientOrTransaction) {
    this.createRunCalls++;
    this.createRunTxArgs.push(tx);
    return super.createRun(p, tx);
  }

  override createCancelledRun(p: CreateCancelledRunInput, tx?: PrismaClientOrTransaction) {
    this.createCancelledRunCalls++;
    this.createCancelledRunTxArgs.push(tx);
    return super.createCancelledRun(p, tx);
  }

  override createFailedRun(p: CreateFailedRunInput, tx?: PrismaClientOrTransaction) {
    this.createFailedRunCalls++;
    this.createFailedRunTxArgs.push(tx);
    return super.createFailedRun(p, tx);
  }

  // findRun is overloaded — override the implementation signature and forward
  // every arg through unchanged.
  override findRun(...args: any[]) {
    this.findRunCalls++;
    return (super.findRun as any)(...args);
  }
}

function freshRunId() {
  return RunId.generate().friendlyId;
}

function freshRunOpsRunId() {
  return RunId.toFriendlyId(generateRunOpsId());
}

const baseTriggerParams = (friendlyId: string, environment: any, taskIdentifier: string) => ({
  number: 1,
  friendlyId,
  environment,
  taskIdentifier,
  payload: "{}",
  payloadType: "application/json",
  context: {},
  traceContext: {},
  traceId: "t12345",
  spanId: "s12345",
  workerQueue: "main",
  queue: `task/${taskIdentifier}`,
  isTest: false,
  tags: [] as string[],
});

const cancelledSnapshot = (friendlyId: string, environment: any) => ({
  friendlyId,
  environment,
  taskIdentifier: "test-task",
  payload: "{}",
  payloadType: "application/json",
  context: {},
  traceContext: {},
  traceId: "0000000000000000aaaa000000000000",
  spanId: "bbbb000000000000",
  queue: "task/test-task",
  isTest: false,
  tags: [] as string[],
});

describe("RunEngine trigger/create routing", () => {
  // trigger create routes through runStore.createRun with the structured
  // DTO, and the persisted run + its nested first RUN_CREATED snapshot land via
  // the single create call.
  containerTest(
    "trigger routes createRun and lands run + first snapshot",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const friendlyId = freshRunId();

        const run = await engine.trigger(
          baseTriggerParams(friendlyId, environment, taskIdentifier),
          prisma
        );

        expect(store.createRunCalls).toBe(1);
        expect(run.friendlyId).toBe(friendlyId);

        const stored = await prisma.taskRun.findFirst({ where: { friendlyId } });
        expect(stored).not.toBeNull();
        expect(stored!.id).toBe(run.id);

        const snapshot = await prisma.taskRunExecutionSnapshot.findFirst({
          where: { runId: run.id },
          orderBy: { createdAt: "asc" },
        });
        expect(snapshot).not.toBeNull();
        expect(snapshot!.executionStatus).toBe("RUN_CREATED");
      } finally {
        await engine.quit();
      }
    }
  );

  // triggerAndWait persists the RUN-associated waitpoint via the single
  // create — the associatedWaitpoint DTO field is nested by the store.
  containerTest(
    "triggerAndWait persists the RUN-associated waitpoint via createRun",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";
        await setupBackgroundWorker(engine, environment, [parentTask, childTask]);

        const parentRun = await engine.trigger(
          baseTriggerParams(freshRunId(), environment, parentTask),
          prisma
        );

        await engine.dequeueFromWorkerQueue({ consumerId: "test", workerQueue: "main" });
        const parentData = await engine.getRunExecutionData({ runId: parentRun.id });
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: parentData!.snapshot.id,
        });

        const callsBefore = store.createRunCalls;
        const childRun = await engine.trigger(
          {
            ...baseTriggerParams(freshRunId(), environment, childTask),
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
          },
          prisma
        );

        expect(store.createRunCalls).toBe(callsBefore + 1);

        const waitpoint = await prisma.waitpoint.findFirst({
          where: { completedByTaskRunId: childRun.id },
        });
        expect(waitpoint).not.toBeNull();
        expect(waitpoint!.type).toBe("RUN");
      } finally {
        await engine.quit();
      }
    }
  );

  // createCancelledRun routes the create, and the P2002 double-pop
  // fallback routes through findRun, returning the same CANCELED row.
  containerTest(
    "createCancelledRun routes create + P2002 fallback find",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const snapshot = cancelledSnapshot(freshRunId(), environment);
        const cancelledAt = new Date();
        const cancelReason = "Test idempotent";

        const first = await engine.createCancelledRun({ snapshot, cancelledAt, cancelReason });
        expect(store.createCancelledRunCalls).toBe(1);

        const findCallsBefore = store.findRunCalls;
        const second = await engine.createCancelledRun({ snapshot, cancelledAt, cancelReason });

        expect(second.id).toBe(first.id);
        expect(second.status).toBe("CANCELED");
        expect(store.createCancelledRunCalls).toBe(2);
        expect(store.findRunCalls).toBeGreaterThan(findCallsBefore);
      } finally {
        await engine.quit();
      }
    }
  );

  // createFailedTaskRun routes the single create arm — no second engine
  // arm exists (the keyless idempotency retry is internal to the store).
  containerTest(
    "createFailedTaskRun routes the single createFailedRun arm",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const friendlyId = freshRunId();
        const run = await engine.createFailedTaskRun({
          friendlyId,
          environment: {
            id: environment.id,
            type: environment.type,
            project: { id: environment.project.id },
            organization: { id: environment.organization.id },
          },
          taskIdentifier: "test-task",
          error: { type: "STRING_ERROR", raw: "boom" },
        });

        expect(store.createFailedRunCalls).toBe(1);
        expect(run.status).toBe("SYSTEM_FAILURE");

        const stored = await prisma.taskRun.findFirst({ where: { friendlyId } });
        expect(stored).not.toBeNull();
        expect(stored!.status).toBe("SYSTEM_FAILURE");
      } finally {
        await engine.quit();
      }
    }
  );

  // Each create forwards the BARE caller tx
  // (undefined on the default path), never the engine's resolved this.prisma, so
  // an injected RoutingRunStore's residency selection is not overridden.
  containerTest(
    "creates forward the bare caller tx, not the resolved client",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        // trigger called with NO tx → store create must receive undefined.
        await engine.trigger(baseTriggerParams(freshRunId(), environment, taskIdentifier));
        expect(store.createRunTxArgs).toHaveLength(1);

        await engine.createCancelledRun({
          snapshot: cancelledSnapshot(freshRunId(), environment),
          cancelledAt: new Date(),
          cancelReason: "tx-arg check",
        });
        expect(store.createCancelledRunTxArgs).toHaveLength(1);

        await engine.createFailedTaskRun({
          friendlyId: freshRunId(),
          environment: {
            id: environment.id,
            type: environment.type,
            project: { id: environment.project.id },
            organization: { id: environment.organization.id },
          },
          taskIdentifier,
          error: { type: "STRING_ERROR", raw: "boom" },
        });
        expect(store.createFailedRunTxArgs).toHaveLength(1);

        // Each create must forward the bare caller tx (undefined here), NOT the
        // engine's resolved client. Assert by identity to avoid a deep compare of
        // the (recursive) Prisma client object.
        for (const arg of [
          ...store.createRunTxArgs,
          ...store.createCancelledRunTxArgs,
          ...store.createFailedRunTxArgs,
        ]) {
          expect(arg).toBeUndefined();
          expect(arg === prisma).toBe(false);
        }
      } finally {
        await engine.quit();
      }
    }
  );

  // The inverse of the bare-tx case above. When the caller DOES pass a tx, the create
  // call sites must forward THAT SAME tx to the store by identity — closing the
  // gap a regression hardcoding `undefined` would slip through every other test.
  containerTest(
    "a non-undefined caller tx is forwarded to the store by identity",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const store = new CountingRunStore({ prisma, readOnlyPrisma: prisma });
      const engine = new RunEngine({ prisma, store, ...baseEngineOptions(redisOptions) });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        // trigger called WITH the real prisma client as the explicit tx → the
        // store create must receive that exact same client by identity.
        await engine.trigger(baseTriggerParams(freshRunId(), environment, taskIdentifier), prisma);
        expect(store.createRunTxArgs).toHaveLength(1);
        expect(store.createRunTxArgs[0]).toBe(prisma);

        await engine.createCancelledRun(
          {
            snapshot: cancelledSnapshot(freshRunId(), environment),
            cancelledAt: new Date(),
            cancelReason: "tx-arg identity check",
          },
          prisma
        );
        expect(store.createCancelledRunTxArgs).toHaveLength(1);
        expect(store.createCancelledRunTxArgs[0]).toBe(prisma);
      } finally {
        await engine.quit();
      }
    }
  );

  // Split/two-store proof: with the run-ops id mint enabled, a NEW-minted run id is
  // classified NEW and a RoutingRunStore writes it to the run-ops (NEW) store,
  // never the LEGACY store. Proves a new run is born on the run-ops store.
  containerTest(
    "split proof: a NEW-minted run lands on the run-ops (NEW) store, not LEGACY",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const newStore = new CountingRunStore({ prisma, readOnlyPrisma: prisma, label: "new" });
      const legacyStore = new CountingRunStore({
        prisma,
        readOnlyPrisma: prisma,
        label: "legacy",
      });
      const routing = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const engine = new RunEngine({
        prisma,
        store: routing,
        ...baseEngineOptions(redisOptions),
      });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const friendlyId = freshRunOpsRunId();
        // Sanity: this id classifies NEW so RoutingRunStore must pick newStore.
        expect(ownerEngine(friendlyId)).toBe("NEW");

        const run = await engine.trigger(
          baseTriggerParams(friendlyId, environment, taskIdentifier)
        );

        expect(newStore.createRunCalls).toBe(1);
        expect(legacyStore.createRunCalls).toBe(0);

        const stored = await prisma.taskRun.findFirst({ where: { friendlyId } });
        expect(stored!.id).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // A child triggered with the parent's residency persists to the
  // SAME store the parent was written to (routing-by-run-id). Both parent and
  // child mint NEW (run-ops id) ids → both land on newStore.
  containerTest("child inherits the parent's residency store", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const newStore = new CountingRunStore({ prisma, readOnlyPrisma: prisma, label: "new" });
    const legacyStore = new CountingRunStore({
      prisma,
      readOnlyPrisma: prisma,
      label: "legacy",
    });
    const routing = new RoutingRunStore({ new: newStore, legacy: legacyStore });
    const engine = new RunEngine({
      prisma,
      store: routing,
      ...baseEngineOptions(redisOptions),
    });

    try {
      const parentTask = "parent-task";
      const childTask = "child-task";
      await setupBackgroundWorker(engine, environment, [parentTask, childTask]);

      const parentRun = await engine.trigger(
        baseTriggerParams(freshRunOpsRunId(), environment, parentTask)
      );

      await engine.dequeueFromWorkerQueue({ consumerId: "test", workerQueue: "main" });
      const parentData = await engine.getRunExecutionData({ runId: parentRun.id });
      await engine.startRunAttempt({
        runId: parentRun.id,
        snapshotId: parentData!.snapshot.id,
      });

      const childRun = await engine.trigger({
        ...baseTriggerParams(freshRunOpsRunId(), environment, childTask),
        resumeParentOnCompletion: true,
        parentTaskRunId: parentRun.id,
        rootTaskRunId: parentRun.id,
      });

      // Both ids are NEW → both routed to the run-ops (NEW) store, never LEGACY.
      expect(ownerEngine(parentRun.friendlyId)).toBe("NEW");
      expect(ownerEngine(childRun.friendlyId)).toBe("NEW");
      expect(newStore.createRunCalls).toBe(2);
      expect(legacyStore.createRunCalls).toBe(0);

      // The child is found on the same store, routed by its run id.
      const childOnRouting = await routing.findRun({ id: childRun.id });
      expect(childOnRouting?.id).toBe(childRun.id);
    } finally {
      await engine.quit();
    }
  });

  // Split-path env integrity / cross-DB control-plane resolution. With a
  // resolver whose assertEnvExists throws, the create is blocked and no row is
  // written; with one that resolves, the create succeeds.
  containerTest(
    "split-path env-existence assertion blocks the create on a dangling env",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      class ThrowingResolver implements ControlPlaneResolver {
        assertEnvCalls: string[] = [];
        constructor(private readonly throws: boolean) {}
        async assertEnvExists(environmentId: string): Promise<void> {
          this.assertEnvCalls.push(environmentId);
          if (this.throws) {
            throw new Error(`Environment not found: ${environmentId}`);
          }
        }
        // Unused by the create path under test.
        async resolveEnv(): Promise<any> {
          return null;
        }
        async resolveAuthenticatedEnv(): Promise<any> {
          return null;
        }
        async resolveWorkerVersion(): Promise<any> {
          return null;
        }
      }

      const throwingResolver = new ThrowingResolver(true);
      const engine = new RunEngine({
        prisma,
        controlPlaneResolver: throwingResolver,
        ...baseEngineOptions(redisOptions),
      });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const friendlyId = freshRunId();

        await expect(
          engine.trigger(baseTriggerParams(friendlyId, environment, taskIdentifier))
        ).rejects.toThrow(/Environment not found/);

        // The assertion ran for the run's env, and NO row was written.
        expect(throwingResolver.assertEnvCalls).toContain(environment.id);
        const stored = await prisma.taskRun.findFirst({ where: { friendlyId } });
        expect(stored).toBeNull();
      } finally {
        await engine.quit();
      }

      // With a resolving resolver, the create succeeds.
      const okResolver = new ThrowingResolver(false);
      const engine2 = new RunEngine({
        prisma,
        controlPlaneResolver: okResolver,
        ...baseEngineOptions(redisOptions),
      });
      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine2, environment, taskIdentifier);
        const friendlyId = freshRunId();
        const run = await engine2.trigger(
          baseTriggerParams(friendlyId, environment, taskIdentifier)
        );
        expect(run.friendlyId).toBe(friendlyId);
        expect(okResolver.assertEnvCalls).toContain(environment.id);
        const stored = await prisma.taskRun.findFirst({ where: { friendlyId } });
        expect(stored).not.toBeNull();
      } finally {
        await engine2.quit();
      }
    }
  );

  // FK-drop app-integrity, single-DB arm: with NO resolver injected, the engine
  // defaults to the passthrough resolver which runs the env check against the one
  // DB. A dangling env (never created) is rejected by that passthrough check, so
  // integrity holds in single-DB mode too.
  containerTest(
    "FK-drop integrity (single-DB): passthrough rejects a deleted env",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine({ prisma, ...baseEngineOptions(redisOptions) });

      try {
        const friendlyId = freshRunId();
        // A clearly non-existent env id of the right shape.
        const danglingEnv = {
          ...environment,
          id: "clxnonexistentenv0000000",
        };

        await expect(
          engine.createFailedTaskRun({
            friendlyId,
            environment: {
              id: danglingEnv.id,
              type: environment.type,
              project: { id: environment.project.id },
              organization: { id: environment.organization.id },
            },
            taskIdentifier: "test-task",
            error: { type: "STRING_ERROR", raw: "boom" },
          })
        ).rejects.toThrow();

        const stored = await prisma.taskRun.findFirst({ where: { friendlyId } });
        expect(stored).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});

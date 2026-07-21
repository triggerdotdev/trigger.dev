// Property: the completion-path reads in runAttemptSystem hit the owning primary, not a lagging replica.
// These drive the REAL RunEngine methods end-to-end (trigger → dequeue → startRunAttempt →
// complete/cancel), not a reimplementation. The store is a real PostgresRunStore whose primary is the
// live container and whose replica is a lagging proxy serving a STALE row for exactly the read under
// test. The same proxy is the engine's readOnlyPrisma, so a read routed to the owning primary
// (this.$.prisma / findRunOnPrimary) never touches the proxy, while a replica-routed read
// (this.$.readOnlyPrisma / client-less findRun) hits the stale value. Unlike the retry test that passes
// its own client into retryOutcomeFromCompletion, this exercises WHICH client the engine threads.

import { assertNonNullable, containerTest, laggingReplica } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

// A read-replica that lags its primary for exactly two completion-path reads, matched by the engine's
// own `select` shape so no unrelated read is disturbed. `retryStale` fabricates the pre-lock snapshot
// (maxAttempts/lockedRetryConfig still null) for the retry-decision read; `usageStale` fabricates a
// pre-accumulation snapshot (usage totals still at their earlier value) for the usage RMW read. Every
// other property/method forwards to the real client. `hits` proves whether the lagging replica was
// actually consulted (0 when the reads go to the primary; >0 when they hit the replica).
type LagState = {
  retryStale: boolean;
  usageStale: { usageDurationMs: number; costInCents: number; machinePreset: string | null } | null;
};

function laggingReadReplica<C extends object>(
  real: C
): { client: C; state: LagState; hits: { retry: number; usage: number } } {
  const state: LagState = { retryStale: false, usageStale: null };
  const hits = { retry: 0, usage: 0 };

  const isRetryDecisionSelect = (select: any) =>
    !!select && select.maxAttempts === true && select.lockedRetryConfig === true;

  // The usage RMW read (attemptSucceeded / cancelRun / permanentlyFailRun) selects exactly these three
  // scalars and nothing else — and crucially never maxAttempts, which distinguishes it from the retry
  // read above.
  const isUsageSelect = (select: any) =>
    !!select &&
    select.usageDurationMs === true &&
    select.costInCents === true &&
    select.machinePreset === true &&
    !("maxAttempts" in select) &&
    !("lockedRetryConfig" in select);

  const realTaskRun = (real as any).taskRun;

  const taskRunProxy = new Proxy(realTaskRun, {
    get(target, prop) {
      if (prop === "findFirst") {
        return async (args?: { select?: any }) => {
          const select = args?.select;
          if (state.retryStale && isRetryDecisionSelect(select)) {
            hits.retry++;
            // Replica has not applied the lock-time write yet: no retry config visible.
            return {
              maxAttempts: null,
              lockedRetryConfig: null,
              usageDurationMs: 0,
              costInCents: 0,
              machinePreset: null,
            };
          }
          if (state.usageStale && isUsageSelect(select)) {
            hits.usage++;
            // Replica has not applied the accumulated-usage write yet: the earlier totals.
            return { ...state.usageStale };
          }
          return target.findFirst(args);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const client = new Proxy(real, {
    get(target, prop) {
      if (prop === "taskRun") {
        return taskRunProxy;
      }
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as C;

  return { client, state, hits };
}

function baseEngineOptions(redisOptions: any) {
  return {
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

const triggerParams = (friendlyId: string, environment: any, taskIdentifier: string) => ({
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

// Drive the real engine to a locked, EXECUTING first attempt over a store whose replica is the
// lagging proxy. Returns everything the individual guards need.
async function triggerAndStartAttempt(
  prisma: PrismaClient,
  redisOptions: any,
  friendlyId: string,
  retryOptions?: any
) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

  const replica = laggingReadReplica(prisma);
  const store = new PostgresRunStore({
    prisma,
    readOnlyPrisma: replica.client as never,
  });
  const engine = new RunEngine({
    prisma,
    readOnlyPrisma: replica.client as never,
    store,
    ...baseEngineOptions(redisOptions),
  });

  try {
    const taskIdentifier = "test-task";
    await setupBackgroundWorker(engine, environment, taskIdentifier, undefined, retryOptions);

    const run = await engine.trigger(
      triggerParams(friendlyId, environment, taskIdentifier),
      prisma
    );

    await setTimeout(500);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_guard",
      workerQueue: "main",
    });
    expect(dequeued.length).toBe(1);

    const attempt = await engine.startRunAttempt({
      runId: dequeued[0].run.id,
      snapshotId: dequeued[0].snapshot.id,
    });

    return { engine, environment, run, attempt, store, replica };
  } catch (e) {
    // Setup threw after the engine was constructed: quit it here so a failed helper does not leak the
    // engine (the callers only run `await engine.quit()` on the success path).
    await engine.quit();
    throw e;
  }
}

describe("RunAttemptSystem completion-path reads must hit the owning primary, not a lagging replica", () => {
  // Retry-vs-fail decision. A retriable failure with attempts remaining must RETRY. The retry config
  // (maxAttempts / lockedRetryConfig) is a lock-time write; if the decision read is served by a lagging
  // replica it reads null and the run is permanently FAILED instead. Reading via the owning primary
  // (this.$.prisma) sees the config and the run retries; a replica-routed read fails it.
  containerTest(
    "attemptFailed retries a retriable run whose lock-time retry config has not replicated",
    async ({ prisma, redisOptions }) => {
      const { engine, run, attempt, replica } = await triggerAndStartAttempt(
        prisma,
        redisOptions,
        "run_nnnnnnnnnnnnnnnnnnnnnnnn01"
      );

      try {
        // The primary now holds maxAttempts=3 (set at lock time). Freeze the replica at the pre-lock
        // snapshot: the ONLY thing that could flip the outcome is which client serves the decision read.
        const primaryRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(primaryRun.maxAttempts).toBe(3);
        replica.state.retryStale = true;

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: false,
            id: run.id,
            error: {
              type: "BUILT_IN_ERROR",
              name: "UserError",
              message: "boom",
              stackTrace: "Error: boom\n    at <anonymous>:1:1",
            },
            retry: { timestamp: Date.now(), delay: 0 },
          },
        });

        // Decision read hit the primary → maxAttempts=3 seen → the run retries.
        expect(result.attemptStatus).toBe("RETRY_IMMEDIATELY");
        expect(result.snapshot.executionStatus).toBe("EXECUTING");
        expect(result.run.status).toBe("EXECUTING");
        // The lagging replica was never consulted for the decision (a replica-routed read would make this > 0).
        expect(replica.hits.retry).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // attemptSucceeded usage/cost RMW. The cumulative usage total is a read-modify-write: read current
  // total, add this attempt, persist. If the read is served by a lagging replica it misses a
  // just-persisted earlier-attempt total and the final usage undercounts. Reading via findRunOnPrimary
  // accumulates on the primary total; a replica-routed read undercounts.
  containerTest(
    "attemptSucceeded accumulates usage on top of the primary total, not a stale replica total",
    async ({ prisma, redisOptions }) => {
      const { engine, run, attempt, replica } = await triggerAndStartAttempt(
        prisma,
        redisOptions,
        "run_nnnnnnnnnnnnnnnnnnnnnnnn11"
      );

      try {
        // Simulate an earlier attempt's usage already persisted on the PRIMARY (1000ms) that the
        // lagging replica has not yet applied (it still reports 0).
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { usageDurationMs: 1000, costInCents: 5, machinePreset: "small-1x" },
        });
        replica.state.usageStale = {
          usageDurationMs: 0,
          costInCents: 0,
          machinePreset: "small-1x",
        };

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: true,
            id: run.id,
            output: `{"ok":true}`,
            outputType: "application/json",
            usage: { durationMs: 500 },
          },
        });
        expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");

        // Primary read: 1000 (primary) + 500 (this attempt) = 1500. A replica read would see 0 → 500 (undercount).
        const finalRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(finalRun.usageDurationMs).toBe(1500);
        expect(replica.hits.usage).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // #permanentlyFailRun usage/cost RMW. A non-retriable failure permanently fails the run and still
  // accumulates the final attempt's usage. Reached with a non-retriable error so
  // retryOutcomeFromCompletion short-circuits to fail_run BEFORE its own read — isolating this to the
  // #permanentlyFailRun usage read. Reading via findRunOnPrimary accumulates on the primary total; a
  // replica-routed read undercounts.
  containerTest(
    "permanentlyFailRun accumulates usage on top of the primary total, not a stale replica total",
    async ({ prisma, redisOptions }) => {
      const { engine, run, attempt, replica } = await triggerAndStartAttempt(
        prisma,
        redisOptions,
        "run_nnnnnnnnnnnnnnnnnnnnnnnn21"
      );

      try {
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { usageDurationMs: 1000, costInCents: 5, machinePreset: "small-1x" },
        });
        replica.state.usageStale = {
          usageDurationMs: 0,
          costInCents: 0,
          machinePreset: "small-1x",
        };

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: false,
            id: run.id,
            // Non-retriable internal error → straight to fail_run → #permanentlyFailRun.
            error: { type: "INTERNAL_ERROR", code: "DISK_SPACE_EXCEEDED" },
            usage: { durationMs: 500 },
          },
        });
        expect(result.attemptStatus).toBe("RUN_FINISHED");
        expect(result.snapshot.executionStatus).toBe("FINISHED");

        // Primary read: 1000 + 500 = 1500. A replica read would see 0 → 500 (undercount).
        const finalRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(finalRun.usageDurationMs).toBe(1500);
        expect(replica.hits.usage).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  // cancelRun usage/cost RMW. Cancelling a run with attempt-duration data accumulates that usage. Driven
  // through the real RunAttemptSystem.cancelRun (the engine's public cancelRun does not expose
  // attemptDurationMs, so the real method is invoked via engine.runAttemptSystem). Reading via
  // findRunOnPrimary accumulates on the primary total; a replica-routed read undercounts.
  containerTest(
    "cancelRun accumulates usage on top of the primary total, not a stale replica total",
    async ({ prisma, redisOptions }) => {
      const { engine, run, replica } = await triggerAndStartAttempt(
        prisma,
        redisOptions,
        "run_nnnnnnnnnnnnnnnnnnnnnnnn31"
      );

      try {
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { usageDurationMs: 1000, costInCents: 5, machinePreset: "small-1x" },
        });
        replica.state.usageStale = {
          usageDurationMs: 0,
          costInCents: 0,
          machinePreset: "small-1x",
        };

        const result = await engine.runAttemptSystem.cancelRun({
          runId: run.id,
          reason: "guard test cancel",
          finalizeRun: true,
          attemptDurationMs: 500,
        });
        assertNonNullable(result);

        // Primary read: 1000 + 500 = 1500. A replica read would see 0 → 500 (undercount).
        const finalRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(finalRun.usageDurationMs).toBe(1500);
        expect(replica.hits.usage).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});

// engine-other read sites — two reads (resolveTaskRunContext, the attemptFailed forceRequeue re-read)
// that must hit the owning primary. Unlike the completion-path cases above (which fabricate STALE reads
// for two `select` shapes via `laggingReadReplica`), these need the whole taskRun row frozen-MISSING on
// the replica, so they use the shared `laggingReplica` ("missing") primitive behind a gate: it forwards
// to the live client during setup so the run reaches EXECUTING, then flips to the frozen replica for
// exactly the read under test. `wasHit()` proves whether the frozen replica was consulted for that read.
function gatedLaggingReplica(prisma: PrismaClient) {
  const frozen = { on: false };
  const lagging = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
  const client = new Proxy(prisma, {
    get(_t, prop) {
      const src: any = frozen.on ? lagging.client : prisma;
      const value = src[prop];
      return typeof value === "function" ? value.bind(src) : value;
    },
  }) as unknown as PrismaClient;
  return { client, frozen, wasHit: (m?: string) => lagging.wasHit(m) };
}

// Drive the real engine to a locked, EXECUTING first attempt over a store whose replica is the gated
// frozen-missing proxy. Mirrors `triggerAndStartAttempt` above but returns the gated replica handle.
async function triggerAndStartAttemptGated(
  prisma: PrismaClient,
  redisOptions: any,
  friendlyId: string,
  retryOptions?: any
) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

  const replica = gatedLaggingReplica(prisma);
  const store = new PostgresRunStore({
    prisma,
    readOnlyPrisma: replica.client as never,
  });
  const engine = new RunEngine({
    prisma,
    readOnlyPrisma: replica.client as never,
    store,
    ...baseEngineOptions(redisOptions),
  });

  try {
    const taskIdentifier = "test-task";
    await setupBackgroundWorker(engine, environment, taskIdentifier, undefined, retryOptions);

    const run = await engine.trigger(
      triggerParams(friendlyId, environment, taskIdentifier),
      prisma
    );

    await setTimeout(500);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_guard",
      workerQueue: "main",
    });
    expect(dequeued.length).toBe(1);

    const attempt = await engine.startRunAttempt({
      runId: dequeued[0].run.id,
      snapshotId: dequeued[0].snapshot.id,
    });

    return { engine, environment, run, attempt, store, replica };
  } catch (e) {
    // Setup threw after the engine was constructed: quit it here so a failed helper does not leak the
    // engine (the callers only run `await engine.quit()` on the success path).
    await engine.quit();
    throw e;
  }
}

describe("RunEngine engine-other reads must hit the owning primary, not a lagging replica", () => {
  // resolveTaskRunContext. Under lag the run's row is not visible on the replica, so a client-less
  // findRun returns null and resolveTaskRunContext throws ServiceValidationError("Task run not found",
  // 404) for a LIVE, EXECUTING run — a spurious 404 on the SpanPresenter's context read. Reading via
  // findRunOnPrimary hits the primary and resolves the context; a replica-routed read 404s.
  containerTest(
    "resolveTaskRunContext resolves a live executing run whose row has not replicated",
    async ({ prisma, redisOptions }) => {
      const { engine, run, replica } = await triggerAndStartAttemptGated(
        prisma,
        redisOptions,
        "run_nnnnnnnnnnnnnnnnnnnnnn73"
      );
      try {
        // Freeze the owning replica for the taskRun read: the ONLY thing that can flip the outcome is
        // which client serves resolveTaskRunContext's read.
        replica.frozen.on = true;
        const ctx = await engine.resolveTaskRunContext(run.id);

        // The read routed to the primary → the live run's context resolved (friendlyId echoed), and the
        // frozen replica was never consulted for the taskRun read.
        expect(ctx.run.id).toBe(run.friendlyId);
        expect(replica.wasHit("taskRun")).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );

  // attemptFailed(forceRequeue) re-read. The forceRequeue branch re-reads the run (status/spanId/... for
  // the runAttemptFailed event). Under lag a client-less findRun returns null and attemptFailed throws
  // ServiceValidationError("Run not found", 404), aborting the crash-requeue of a LIVE run. Reading via
  // findRunOnPrimary hits the primary; a replica-routed read 404s.
  containerTest(
    "attemptFailed(forceRequeue) re-reads a live run on the primary",
    async ({ prisma, redisOptions }) => {
      const { engine, run, attempt, replica } = await triggerAndStartAttemptGated(
        prisma,
        redisOptions,
        "run_nnnnnnnnnnnnnnnnnnnnnn83",
        { maxAttempts: 3 }
      );
      try {
        replica.frozen.on = true;
        const result = await engine.runAttemptSystem.attemptFailed({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: false,
            id: run.id,
            error: {
              type: "BUILT_IN_ERROR",
              name: "UserError",
              message: "boom",
              stackTrace: "Error: boom\n    at <anonymous>:1:1",
            },
            retry: { timestamp: Date.now(), delay: 0 },
          },
          forceRequeue: true,
          tx: prisma,
        });

        // The forceRequeue re-read hit the primary → attemptFailed completed (no 404) and returned a
        // live result for this run; the frozen replica was never consulted for the taskRun read.
        expect(result.run.id).toBe(run.id);
        expect(result.attemptStatus).toBeDefined();
        expect(replica.wasHit("taskRun")).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );
});

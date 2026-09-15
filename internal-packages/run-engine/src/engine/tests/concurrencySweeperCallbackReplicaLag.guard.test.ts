// Replica-lag guard for the run-store read inside the private #concurrencySweeperCallback. The
// callback cannot be called by name (it is private), but the engine wires the REAL bound method as
// the RunQueue's concurrency-sweeper callback (`callback: this.#concurrencySweeperCallback.bind(this)`)
// and `RunQueue.options` is public-readonly, so this test invokes
// `engine.runQueue.options.concurrencySweeper.callback([...])` — the exact production callback object,
// driven end-to-end over the engine's real runStore. RunQueue's own Redis scan is the only thing
// bypassed (it merely feeds the callback the runIds it already receives from
// `processCurrentConcurrencyRunIds`).
//
// The read: findRuns for runs finished > 10 min ago with a final status and an org set (client-less →
// REPLICA); the callback releases the stale concurrency those runs still hold.
//
// Property: this lag is tolerable and self-healing. Under lag the read misses the finished run and the
// callback returns [] (no runs marked for ack), so the run keeps its concurrency slot THIS scan; the
// sweeper runs periodically, so the next scan (once replicated) releases it — a miss delays cleanup by
// one scan, never wrongly releases a live run, and never leaks permanently. A second engine over a
// caught-up replica proves the SAME wired callback returns the run.

import { containerTest, laggingReplica } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment } from "./setup.js";

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

async function seedFinishedRun(prisma: PrismaClient, environment: any, runId: string) {
  // Completed 30 min ago, final status, org set — matches the callback's predicate exactly. On the PRIMARY.
  await prisma.taskRun.create({
    data: {
      id: runId,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: `fr_${runId}`,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: `trace_${runId}`,
      spanId: `span_${runId}`,
      queue: "task/my-task",
      runtimeEnvironmentId: environment.id,
      projectId: environment.project.id,
      organizationId: environment.organization.id,
      environmentType: "PRODUCTION",
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      completedAt: new Date(Date.now() - 30 * 60 * 1000),
    },
  });
}

describe("concurrency sweeper callback — replica-lag guard", () => {
  containerTest(
    "the wired sweeper callback misses a finished run under lag (returns []) — self-healing; a caught-up replica proves the same callback finds it",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const runId = "run_nnnnnnnnnnnnnnnnnnnnnn91";
      await seedFinishedRun(prisma, environment, runId);

      // Engine A — taskRun frozen-missing on the replica; the callback's client-less findRuns routes there.
      const laggingReplicaHandle = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      const laggingStore = new PostgresRunStore({
        prisma,
        readOnlyPrisma: laggingReplicaHandle.client as never,
      });
      const laggingEngine = new RunEngine({
        prisma,
        readOnlyPrisma: laggingReplicaHandle.client as never,
        store: laggingStore,
        ...baseEngineOptions(redisOptions),
      });

      // Engine B — caught-up replica (control), proving the wired callback path is live.
      const liveStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const liveEngine = new RunEngine({
        prisma,
        readOnlyPrisma: prisma,
        store: liveStore,
        ...baseEngineOptions(redisOptions),
      });

      try {
        // Lagging: the REAL wired callback (engine's private #concurrencySweeperCallback) misses the
        // finished run and returns [] — the run keeps its concurrency slot this scan (no throw).
        const lagging = await laggingEngine.runQueue.options.concurrencySweeper!.callback([runId]);
        expect(lagging).toEqual([]);
        expect(laggingReplicaHandle.wasHit("taskRun")).toBe(true);

        // Caught-up control: the SAME wired callback finds the finished run and marks it for ack.
        const caughtUp = await liveEngine.runQueue.options.concurrencySweeper!.callback([runId]);
        expect(caughtUp.map((r) => r.id)).toEqual([runId]);
        expect(caughtUp[0]!.orgId).toBe(environment.organization.id);

        // The miss is pure lag: the run is genuinely finished on the PRIMARY (so a later scan releases it).
        const onPrimary = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        expect(onPrimary.status).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        await laggingEngine.quit();
        await liveEngine.quit();
      }
    }
  );
});

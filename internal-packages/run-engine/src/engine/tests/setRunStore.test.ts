import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { DelegatingRunStore, PostgresRunStore, type RunStore } from "@internal/run-store";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

// A recorder around a REAL store (a fault-injector-style wrapper, not a mock): counts createRun so the
// test can see WHICH store the engine's systems actually route a trigger through.
class RecordingRunStore extends DelegatingRunStore {
  public createRunCalls = 0;
  override createRun(
    ...args: Parameters<RunStore["createRun"]>
  ): ReturnType<RunStore["createRun"]> {
    this.createRunCalls++;
    return super.createRun(...args);
  }
}

// Blocker-1 production wiring: the engine and its systems construct before the snapshot-store machinery
// decision can be made, so boot rebuilds the run store decorated and calls engine.setRunStore(...). This
// proves the swap actually reaches the SYSTEMS (which read the store live from the shared resources), not
// just the engine's own field: a trigger AFTER the swap routes createRun through the NEW store. Reverting
// the `this.#resources.runStore = store` line in setRunStore leaves the systems on the old store and turns
// the post-swap assertion red.
describe("RunEngine.setRunStore", () => {
  containerTest(
    "swaps the store the engine's systems route through",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const storeA = new RecordingRunStore(
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma })
      );
      const storeB = new RecordingRunStore(
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma })
      );

      const engine = new RunEngine({
        prisma,
        store: storeA,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: {
          redis: redisOptions,
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
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

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const trigger = (n: number) =>
          engine.trigger(
            {
              number: n,
              friendlyId: generateFriendlyId("run"),
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: `t_setstore_${n}`,
              spanId: `s_setstore_${n}`,
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
            },
            prisma
          );

        await trigger(1);
        expect(storeA.createRunCalls).toBe(1);
        expect(storeB.createRunCalls).toBe(0);

        engine.setRunStore(storeB);

        await trigger(2);
        // The swap reached the systems: the second run routed through storeB, and storeA saw nothing new.
        expect(storeB.createRunCalls).toBe(1);
        expect(storeA.createRunCalls).toBe(1);
        expect(engine.runStore).toBe(storeB);
      } finally {
        await engine.quit();
      }
    }
  );
});

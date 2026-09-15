// Finding 83-2: the waitpoint coordinator must resolve the CURRENT run store, not the one captured at
// construction. WaitpointSystem builds LegacyPostgresWaitpointCoordinator in its constructor, and the
// app calls engine.setRunStore(decorated) on EVERY armed boot to swap the decorated (run-ops) store in.
// If the coordinator froze the construction-time store, every waitpoint operation after the swap would
// bypass the decorated store. This drives a REAL RunEngine (real Postgres + Redis), swaps in a store
// that records the reads/writes routed through it, and proves a post-swap waitpoint op hits it.
import { containerTest } from "@internal/testcontainers";
import type { RunStore } from "@internal/run-store";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

// Wrap a REAL store: every method delegates to it unchanged, but calls to `upsertWaitpoint` (the write
// createManualWaitpoint routes through) are counted. Not a mock — the real store does the real work; the
// wrapper only observes which store instance the coordinator actually reached.
function decorateCountingUpsert(real: RunStore): { store: RunStore; upsertCalls: () => number } {
  let calls = 0;
  const store = new Proxy(real as any, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "upsertWaitpoint" && typeof value === "function") {
        return (...args: any[]) => {
          calls++;
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as RunStore;
  return { store, upsertCalls: () => calls };
}

function engineOptions(redisOptions: any, prisma: any) {
  return {
    prisma,
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

describe("WaitpointSystem coordinator honors a post-boot setRunStore swap", () => {
  containerTest(
    "a waitpoint operation after setRunStore routes through the decorated (post-swap) store",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(engineOptions(redisOptions, prisma));

      try {
        // The app performs exactly this swap on every armed boot: build the engine, then point it at the
        // decorated store. The coordinator was constructed before this call.
        const decorated = decorateCountingUpsert(engine.runStore);
        engine.setRunStore(decorated.store);

        // A standalone manual waitpoint create routes coordinator -> runStore.upsertWaitpoint.
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
        });

        expect(waitpoint).toBeTruthy();
        // GREEN with the getter fix: the coordinator read the post-swap store, so the decorated store saw
        // the write. RED before the fix: the coordinator still held the construction-time store and the
        // decorated store's counter stayed at 0.
        expect(decorated.upsertCalls()).toBeGreaterThan(0);
      } finally {
        await engine.quit();
      }
    }
  );
});

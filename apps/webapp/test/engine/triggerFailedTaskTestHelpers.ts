// Shared harness for the triggerFailedTask.*.test.ts family, split from the
// original single test file so CI's duration-based sharding can balance the
// container-heavy tests. Not a test file (vitest's include only matches *.test.ts).
import { RunEngine } from "@internal/run-engine";
import { trace } from "@opentelemetry/api";
import { TriggerFailedTaskService } from "../../app/runEngine/services/triggerFailedTask.server";
import { EventRepository } from "../../app/v3/eventRepository/eventRepository.server";

// Bind the service's trace-event writes to the testcontainer DB. Without this,
// call() resolves the repository via getEventRepository → global prisma, which
// points at a database that doesn't exist in CI.
export function makeService(prisma: any, engine: RunEngine) {
  return new TriggerFailedTaskService({
    prisma,
    engine,
    // Read the parent through the same store the engine wrote it to.
    runStore: engine.runStore,
    eventRepository: {
      repository: new EventRepository(prisma, prisma, {
        batchSize: 100,
        batchInterval: 1000,
        retentionInDays: 30,
        partitioningEnabled: false,
      }),
      store: "taskEvent",
    },
  });
}

export function makeEngine(prisma: any, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
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

import { RunEngine } from "@internal/run-engine";
import { trace } from "@opentelemetry/api";
import type { PrismaClient } from "@trigger.dev/database";

/** A minimal real engine on the container's Redis, shared by the grounding service and route suites. */
export function buildGroundingTestEngine(prisma: PrismaClient, redisOptions: any) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
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
}

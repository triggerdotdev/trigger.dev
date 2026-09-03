// The publish guard (ensureRunPublished) must re-publish a run whose QUEUED snapshot committed but
// whose queue publish was lost, and must be a no-op once the snapshot is superseded. Real engine.
import { containerTest } from "@internal/testcontainers";
import { SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

function buildEngine(prisma: PrismaClient, redisOptions: any) {
  return new RunEngine({
    prisma,
    completionGuardDelayMs: 50,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function triggerExecutingRun(
  engine: RunEngine,
  prisma: PrismaClient,
  env: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  taskIdentifier: string,
  friendlyId: string,
  spanId: string
) {
  await setupBackgroundWorker(engine, env, taskIdentifier);
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-${spanId}`,
      spanId,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
  await setTimeout(500);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: `consumer-${spanId}`,
    workerQueue: "main",
  });
  await engine.startRunAttempt({ runId: dequeued[0].run.id, snapshotId: dequeued[0].snapshot.id });
  return run;
}

describe("run publish guard", () => {
  containerTest(
    "ensureRunPublished re-publishes a QUEUED run whose publish was lost",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(engine, prisma, env, "pub-task", "run_pub1", "sp1");

        // Simulate a resume that committed the QUEUED snapshot but lost the queue publish.
        const latest = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        const snapshotId = SnapshotId.generate().id;
        await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          snapshotId,
          run: { id: run.id, status: latest.runStatus, attemptNumber: latest.attemptNumber },
          snapshot: { executionStatus: "QUEUED", description: "stranded, publish lost" },
          previousSnapshotId: latest.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        // Not in the queue yet.
        const before = await engine.dequeueFromWorkerQueue({
          consumerId: "pub-before",
          workerQueue: "main",
        });
        expect(before.map((d) => d.run.id)).not.toContain(run.id);

        await engine.enqueueSystem.ensureRunPublished({ runId: run.id, snapshotId });

        // Now dequeuable: the guard re-published it.
        const after = await engine.dequeueFromWorkerQueue({
          consumerId: "pub-after",
          workerQueue: "main",
        });
        expect(after.map((d) => d.run.id)).toContain(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "ensureRunPublished is a no-op once the snapshot is superseded (run already executing)",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(engine, prisma, env, "pub-task2", "run_pub2", "sp2");

        // The run is EXECUTING (latest snapshot is not the stale QUEUED id we pass).
        await engine.enqueueSystem.ensureRunPublished({
          runId: run.id,
          snapshotId: SnapshotId.generate().id,
        });

        const after = await engine.dequeueFromWorkerQueue({
          consumerId: "pub-noop",
          workerQueue: "main",
        });
        expect(after.map((d) => d.run.id)).not.toContain(run.id); // not re-queued
      } finally {
        await engine.quit();
      }
    }
  );
});

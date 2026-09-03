// The publish guard (ensureRunPublished) must re-publish a run whose QUEUED snapshot committed but
// whose queue publish was lost, and must be a no-op once the snapshot is superseded. Real engine.
import { containerTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

// A real store that, once armed, pauses inside the QUEUED snapshot write AFTER it commits but before
// returning — so the enqueue that called it stays inside the run lock, post-commit / pre-publish. This
// deterministically holds the exact window the publish guard must serialize against. `super.*` runs the
// genuine store — never a mock.
class BarrierEnqueueStore extends PostgresRunStore {
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;
  private signalReached: (() => void) | null = null;
  public reached: Promise<void> = Promise.resolve();

  armForQueuedSnapshot() {
    this.reached = new Promise((res) => (this.signalReached = res));
    this.gate = new Promise((res) => (this.openGate = res));
  }
  release() {
    this.openGate?.();
  }

  override async createExecutionSnapshot(
    input: Parameters<PostgresRunStore["createExecutionSnapshot"]>[0],
    tx?: any
  ): ReturnType<PostgresRunStore["createExecutionSnapshot"]> {
    const result = await super.createExecutionSnapshot(input, tx);
    if (this.gate && input.snapshot.executionStatus === "QUEUED") {
      const gate = this.gate;
      this.gate = null; // one-shot
      this.signalReached?.();
      await gate; // hold the run lock here until the test releases us
    }
    return result;
  }
}

function buildEngine(prisma: PrismaClient, redisOptions: any, store?: PostgresRunStore) {
  return new RunEngine({
    prisma,
    ...(store ? { store } : {}),
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

        // A genuinely-lost resume-publish holds no concurrency claim: the suspend that preceded the
        // resume released the slot. Reflect that so the guard sees the run as absent, not in-flight.
        await engine.runQueue.releaseAllConcurrency(env.organization.id, run.id);

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

  // #3, sorted-set stage: a lost ack redelivers the guard while the run is still QUEUED and waiting in
  // the sorted set. The run is already in-flight, so the guard is a no-op and it is dequeued exactly once.
  containerTest(
    "ensureRunPublished does not double-deliver a run already waiting in the queue",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "pub-idem");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_pubidem",
            environment: env,
            taskIdentifier: "pub-idem",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-pi",
            spanId: "spi",
            workerQueue: "main",
            queue: "task/pub-idem",
            isTest: false,
            tags: [],
          },
          prisma
        );
        await setTimeout(500);

        // The run is QUEUED and already waiting in the sorted set (trigger enqueued it). Fire the guard
        // twice as if its ack had been lost; each call must detect the in-flight message and skip.
        const latest = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        expect(latest.executionStatus).toBe("QUEUED");
        await engine.enqueueSystem.ensureRunPublished({ runId: run.id, snapshotId: latest.id });
        await engine.enqueueSystem.ensureRunPublished({ runId: run.id, snapshotId: latest.id });

        // Drain the worker queue; the run must appear exactly once across all dequeues.
        let seen = 0;
        for (let i = 0; i < 3; i++) {
          const batch = await engine.dequeueFromWorkerQueue({
            consumerId: `pub-idem-${i}`,
            workerQueue: "main",
          });
          seen += batch.filter((d) => d.run.id === run.id).length;
        }
        expect(seen).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  // #1, dispatched stage: the message has moved to a worker queue (holding a concurrency claim) but the
  // DB snapshot still reads QUEUED — no consumer has popped it yet. Re-publishing here would add a
  // duplicate AND strip the live run's concurrency claim, so the guard must detect the in-flight
  // message and skip. The run is then delivered exactly once.
  containerTest(
    "ensureRunPublished does not corrupt a run already dispatched to a worker queue",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "pub-disp");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_pubdisp",
            environment: env,
            taskIdentifier: "pub-disp",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-pd",
            spanId: "spd",
            workerQueue: "main",
            queue: "task/pub-disp",
            isTest: false,
            tags: [],
          },
          prisma
        );
        await setTimeout(500);

        // Move the message from the sorted set onto the worker queue (dispatched, holding a concurrency
        // claim) but do NOT let a consumer pop it — the DB snapshot stays QUEUED.
        await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
        const latest = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        expect(latest.executionStatus).toBe("QUEUED");
        expect(await engine.runQueue.currentConcurrencyOfQueue(env, run.queue)).toBe(1);

        // Guard fires (ack lost). With the fix it is a no-op: no duplicate, no concurrency strip.
        await engine.enqueueSystem.ensureRunPublished({ runId: run.id, snapshotId: latest.id });
        expect(await engine.runQueue.currentConcurrencyOfQueue(env, run.queue)).toBe(1);

        // Delivered exactly once: pop it, start the attempt, and confirm no second delivery.
        const dq = await engine.dequeueFromWorkerQueue({
          consumerId: "pub-disp-c",
          workerQueue: "main",
        });
        expect(dq.filter((d) => d.run.id === run.id).length).toBe(1);
        await engine.startRunAttempt({ runId: dq[0].run.id, snapshotId: dq[0].snapshot.id });
        const again = await engine.dequeueFromWorkerQueue({
          consumerId: "pub-disp-c2",
          workerQueue: "main",
        });
        expect(again.map((d) => d.run.id)).not.toContain(run.id);
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

  // The guard and the original resume publisher share the run lock, so they cannot both observe "absent"
  // across a dispatch transition. A barrier holds the resume publisher inside the lock (post-commit,
  // pre-publish); the guard must block on the lock until it releases, then see the message in-flight.
  containerTest(
    "ensureRunPublished blocks on the run lock while the resume publisher holds it",
    async ({ prisma, redisOptions }) => {
      const store = new BarrierEnqueueStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "pub-lock");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_publock",
            environment: env,
            taskIdentifier: "pub-lock",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-pl",
            spanId: "spl",
            workerQueue: "main",
            queue: "task/pub-lock",
            isTest: false,
            tags: [],
          },
          prisma
        );
        await setTimeout(500);
        // Bring it to EXECUTING and release its concurrency, as a suspend would, so a resume is valid.
        await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
        const dq0 = await engine.dequeueFromWorkerQueue({
          consumerId: "pl-d",
          workerQueue: "main",
        });
        await engine.startRunAttempt({ runId: dq0[0].run.id, snapshotId: dq0[0].snapshot.id });
        await engine.runQueue.releaseAllConcurrency(env.organization.id, run.id);
        const execSnap = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        const fullRun = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });

        // Start the resume enqueue; it commits the QUEUED snapshot then pauses inside the run lock.
        store.armForQueuedSnapshot();
        const p1 = engine.enqueueSystem.enqueueRun({
          run: fullRun,
          env,
          snapshot: { status: "QUEUED", description: "resume" },
          previousSnapshotId: execSnap.id,
          armPublishGuard: true,
        });
        await store.reached;

        const queuedSnap = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        expect(queuedSnap.executionStatus).toBe("QUEUED");

        // The guard must not proceed while the publisher holds the lock.
        let guardDone = false;
        const p2 = engine.enqueueSystem
          .ensureRunPublished({ runId: run.id, snapshotId: queuedSnap.id })
          .then(() => {
            guardDone = true;
          });
        await setTimeout(500);
        expect(guardDone).toBe(false);

        // Release the publisher; it publishes and drops the lock, then the guard runs and skips.
        store.release();
        await p1;
        await p2;

        // Exactly one delivery, concurrency claim intact.
        await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
        expect(await engine.runQueue.currentConcurrencyOfQueue(env, run.queue)).toBe(1);
        const dq = await engine.dequeueFromWorkerQueue({ consumerId: "pl-c", workerQueue: "main" });
        expect(dq.filter((d) => d.run.id === run.id).length).toBe(1);
        await engine.startRunAttempt({ runId: dq[0].run.id, snapshotId: dq[0].snapshot.id });
        const again = await engine.dequeueFromWorkerQueue({
          consumerId: "pl-c2",
          workerQueue: "main",
        });
        expect(again.map((d) => d.run.id)).not.toContain(run.id);
      } finally {
        await engine.quit();
      }
    }
  );
});

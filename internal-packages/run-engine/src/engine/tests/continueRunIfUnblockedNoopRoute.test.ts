// The existing snapshot read supplies server-side write context. No-op jobs remain no-ops, and actual
// unblock transitions do not need a second route lookup. A recorder delegates to the real store.
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import {
  DelegatingRunStore,
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type RunStore,
} from "@internal/run-store";
import type { TaskRunExecutionStatus, TaskRunStatus } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";

// Counts the durable residency read the fix is about. Everything else delegates to the real store.
class ReadSnapshotRouteRecorder extends DelegatingRunStore {
  public readSnapshotRouteCalls = 0;
  override readSnapshotRoute(
    ...args: Parameters<RunStore["readSnapshotRoute"]>
  ): ReturnType<RunStore["readSnapshotRoute"]> {
    this.readSnapshotRouteCalls++;
    return super.readSnapshotRoute(...args);
  }
}

// Every no-op status: continueRunIfUnblocked must return without a transition AND without resolving
// residency. PENDING_CANCEL and FINISHED share a case arm; both are listed so either regressing alone
// is caught.
const NOOP_STATUSES: TaskRunExecutionStatus[] = [
  "RUN_CREATED",
  "DELAYED",
  "QUEUED",
  "PENDING_EXECUTING",
  "QUEUED_EXECUTING",
  "EXECUTING",
  "PENDING_CANCEL",
  "FINISHED",
];

describe("continueRunIfUnblocked route resolution", () => {
  containerTest(
    "no-op statuses remain unchanged and writing branches reuse snapshot context without route lookups",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new TaskRunExecutionSnapshotStore(delegate, {
        store: snapshotStore,
        mode: "redis-only",
        resolveDial: () => "redis-only",
        residencyResolver: new SnapshotResidencyResolver({
          store: snapshotStore,
        }),
        resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
        logicalRunStoreRoute: ROUTE,
      });

      // The recorder wraps the DECORATED store — the exact object the engine's systems call
      // readSnapshotRoute on — so the tally reflects the real production call, not a lower layer the
      // decorator may satisfy without delegating.
      const recorder = new ReadSnapshotRouteRecorder(store);

      const engine = new RunEngine({
        prisma,
        store: recorder,
        worker: { redis: redisOptions, disabled: true },
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
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        await setupBackgroundWorker(engine, env, "test-task");

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_nooproute1",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-noop",
            spanId: "s-noop",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        const latest = async () =>
          await store.findLatestExecutionSnapshot(run.id, prisma, env.id as string);

        // Seed a genuine head with the target status through the REAL store, then drive the real
        // continueRunIfUnblocked. The run carries no blocking waitpoints, so the empty block state
        // passes the "still blocked" guard and reaches the status switch.
        async function seedStatus(
          executionStatus: TaskRunExecutionStatus,
          opts?: { runStatus?: TaskRunStatus; checkpointId?: string }
        ) {
          const head = await latest();
          if (!head) throw new Error("no head snapshot to chain from");
          await store.createExecutionSnapshot(
            {
              run: {
                id: run.id,
                status: opts?.runStatus ?? head.runStatus,
                attemptNumber: head.attemptNumber ?? undefined,
              },
              snapshot: { executionStatus, description: `seeded ${executionStatus}` },
              previousSnapshotId: head.id,
              environmentId: head.environmentId,
              environmentType: head.environmentType,
              projectId: head.projectId,
              organizationId: head.organizationId,
              checkpointId: opts?.checkpointId,
            } as never,
            prisma
          );
        }

        const continueRouteless = async () => {
          recorder.readSnapshotRouteCalls = 0;
          const result = await (engine as any).waitpointSystem.continueRunIfUnblocked({
            runId: run.id,
          });
          return { result, calls: recorder.readSnapshotRouteCalls };
        };

        // ---- no-op statuses: zero durable route resolutions ----
        for (const status of NOOP_STATUSES) {
          await seedStatus(status, {
            runStatus: status === "FINISHED" ? "COMPLETED_SUCCESSFULLY" : undefined,
          });
          const { result, calls } = await continueRouteless();
          expect(result.status, `${status} must be a no-op`).toBe("skipped");
          expect(calls, `${status} must perform ZERO readSnapshotRoute calls`).toBe(0);
        }

        // ---- SUSPENDED, canceled without a checkpoint: early return precedes any resolution ----
        await seedStatus("SUSPENDED", { runStatus: "CANCELED" });
        {
          const { result, calls } = await continueRouteless();
          expect(result.status).toBe("skipped");
          expect(calls, "canceled-while-suspended returns before resolving residency").toBe(0);
        }

        // ---- Writing branches reuse the already-read snapshot's durable context. ----
        await seedStatus("EXECUTING_WITH_WAITPOINTS", { runStatus: "EXECUTING" });
        {
          const { result, calls } = await continueRouteless();
          expect(result.status).toBe("unblocked");
          expect(calls, "the writing branch reuses its snapshot context").toBe(0);
          expect((await latest())?.executionStatus).toBe("EXECUTING");
          expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
        }

        // A second blocking cycle remains route-free and advances the same resident head.
        await seedStatus("EXECUTING_WITH_WAITPOINTS", { runStatus: "EXECUTING" });
        {
          recorder.readSnapshotRouteCalls = 0;
          const result = await (engine as any).waitpointSystem.continueRunIfUnblocked({
            runId: run.id,
          });
          expect(result.status).toBe("unblocked");
          expect(
            recorder.readSnapshotRouteCalls,
            "the existing snapshot read must supply write context"
          ).toBe(0);
          expect((await latest())?.executionStatus).toBe("EXECUTING");
          expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
        }
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});

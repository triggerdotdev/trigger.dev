// Verifies TtlSystem.expireRunsBatch reads its findRuns existence check off the owning store's WRITER,
// so a PENDING run whose row has not yet replicated is still found and EXPIRED (never orphaned as
// not_found). Because the TTL Lua script has already dequeued the run, a stale replica miss would not
// self-heal. Drives the REAL engine method against a PostgresRunStore whose replica is frozen; real
// Postgres + Redis via containerTest, laggingReplica from @internal/testcontainers, never mocked.

import { containerTest, laggingReplica } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { PostgresRunStore } from "@internal/run-store";
import type { RunStore, CreateRunInput } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment } from "../tests/setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngine(prisma: PrismaClient, redisOptions: any, store: RunStore) {
  return new RunEngine({
    prisma,
    store,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      processWorkerQueueDebounceMs: 50,
      masterQueueConsumersDisabled: true,
      // Disable the automatic TTL sweep so the ONLY caller of expireRunsBatch is our explicit
      // invocation — nothing races it or re-expires the run behind our back.
      ttlSystem: { disabled: true },
    },
    runLock: {
      redis: redisOptions,
    },
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
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_ttl_lag",
      spanId: "span_ttl_lag",
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      ttl: "1s",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "QUEUED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: params.runtimeEnvironmentId,
      environmentType: "PRODUCTION",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

describe("TtlSystem.expireRunsBatch — read-your-writes under replica lag", () => {
  containerTest(
    "expires a PENDING run whose row is not yet visible on the lagging replica",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // The store's replica lags: `taskRun` reads come back empty, exactly as just after a
      // very-short-TTL run is created and immediately swept. The WRITER (prisma) is up to date.
      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
      const store = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client });

      const engine = createEngine(prisma, redisOptions, store);

      try {
        // Seed the run directly through the store's WRITER so its row exists on the primary but is NOT
        // visible on the lagging replica. (Created directly rather than via engine.trigger so that
        // setup performs no replica reads that could interfere with the single read under test.)
        const runId = "run_ttl_lag_guard_0000001";
        await store.createRun(
          buildCreateRunInput({
            runId,
            friendlyId: "run_ttllag1",
            organizationId: authenticatedEnvironment.organization.id,
            projectId: authenticatedEnvironment.project.id,
            runtimeEnvironmentId: authenticatedEnvironment.id,
          })
        );

        // Sanity: the run really IS an expirable PENDING run on the writer, so the only reason it
        // could fail to expire is a misrouted read against the stale replica.
        const onPrimary = await store.findRun({ id: runId }, prisma);
        expect(onPrimary).not.toBeNull();
        expect(onPrimary!.status).toBe("PENDING");

        // Drive the REAL engine method. Its findRuns read is handed the writer (this.$.prisma) and
        // finds the run rather than hitting the lagging replica.
        const result = await engine.ttlSystem.expireRunsBatch([runId]);

        // The run is expired and nothing is skipped.
        expect(result.expired).toEqual([runId]);
        expect(result.skipped).toEqual([]);

        // The run is durably EXPIRED on the writer (the persisted outcome under test).
        const persisted = await prisma.taskRun.findUniqueOrThrow({ where: { id: runId } });
        expect(persisted.status).toBe("EXPIRED");

        // The existence-check read routes to the writer, so the stale replica is NEVER consulted for the
        // expiry check — the seam these assertions pin.
        expect(replica.wasHit("taskRun")).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );
});

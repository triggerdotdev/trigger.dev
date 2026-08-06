import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateRunInput } from "./types.js";

const NEW_ID_26 = "k".repeat(24) + "01";

function makeDedicatedStore(prisma17: RunOpsPrismaClient) {
  return new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
}

function trackInteractiveTx(prisma17: RunOpsPrismaClient) {
  const original = prisma17.$transaction.bind(prisma17);
  const state = { interactiveCalls: 0 };
  (prisma17 as { $transaction: unknown }).$transaction = (
    arg: unknown,
    options?: { timeout?: number; maxWait?: number }
  ) => {
    if (typeof arg === "function") {
      state.interactiveCalls += 1;
      return (original as (fn: unknown, o?: unknown) => unknown)(arg, { ...options, timeout: 1 });
    }
    return (original as (a: unknown, o?: unknown) => unknown)(arg, options);
  };
  return state;
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  suffix: string;
}): CreateRunInput {
  return {
    data: {
      id: params.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: `env_${params.suffix}`,
      environmentType: "DEVELOPMENT",
      organizationId: `org_${params.suffix}`,
      projectId: `proj_${params.suffix}`,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      traceContext: { trace: "ctx" },
      traceId: `trace_${params.runId}`,
      spanId: `span_${params.runId}`,
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: `env_${params.suffix}`,
      environmentType: "DEVELOPMENT",
      projectId: `proj_${params.suffix}`,
      organizationId: `org_${params.suffix}`,
    },
  };
}

describe("createRun on the dedicated store does not wrap a single-write create in an interactive transaction", () => {
  heteroRunOpsPostgresTest(
    "a create with no associated waitpoint survives an interactive-tx budget of 1ms (run + snapshot persist)",
    async ({ prisma17 }) => {
      const tx = trackInteractiveTx(prisma17);
      const store = makeDedicatedStore(prisma17);
      const runId = `run_${NEW_ID_26}`;

      await store.createRun(
        buildCreateRunInput({ runId, friendlyId: "run_no_tx", suffix: "no_tx" })
      );

      expect(tx.interactiveCalls).toBe(0);

      const run = await prisma17.taskRun.findFirstOrThrow({ where: { id: runId } });
      expect(run.status).toBe("PENDING");
      const snap = await prisma17.taskRunExecutionSnapshot.findFirst({
        where: { runId, executionStatus: "RUN_CREATED" },
      });
      expect(snap).not.toBeNull();
    }
  );
});

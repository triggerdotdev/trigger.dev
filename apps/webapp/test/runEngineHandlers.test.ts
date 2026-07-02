import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import type { CompleteBatchResult } from "@internal/run-engine";
import { describe, expect, vi } from "vitest";
import {
  handleBatchCompletion,
  readRunForEvent,
  readRunForEventOrThrow,
  resolveBatchRunOpsWriter,
  type BatchCompletionDeps,
  type EventReadDeps,
} from "~/v3/runEngineHandlersShared.server";

vi.setConfig({ testTimeout: 60_000 });

// Proves two routing properties against REAL Postgres (never mocked):
//   1. the 7 TaskRun event reads resolve run-ops new-or-old via read-through;
//   2. the batch update + error-createMany transaction commits entirely on the
//      run-ops writer that owns the BatchTaskRun row (no boundary-spanning txn).

const EVENT_SELECT = {
  id: true,
  friendlyId: true,
  traceId: true,
  spanId: true,
  parentSpanId: true,
  createdAt: true,
  completedAt: true,
  taskIdentifier: true,
  projectId: true,
  runtimeEnvironmentId: true,
  environmentType: true,
  isTest: true,
  organizationId: true,
  taskEventStore: true,
  runTags: true,
  batchId: true,
} as const;

async function seedEnvironment(prisma: PrismaClient, slugSuffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slugSuffix}`,
      pkApiKey: `pk_dev_${slugSuffix}`,
      shortcode: `short_${slugSuffix}`,
    },
  });
  return { organization, project, environment };
}

async function seedTaskRun(
  prisma: PrismaClient,
  params: {
    id: string;
    friendlyId: string;
    organizationId: string;
    projectId: string;
    runtimeEnvironmentId: string;
    runTags?: string[];
  }
) {
  return prisma.taskRun.create({
    data: {
      id: params.id,
      engine: "V2",
      status: "COMPLETED_SUCCESSFULLY",
      friendlyId: params.friendlyId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      traceId: "trace_1",
      spanId: "span_1",
      queue: "task/my-task",
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      projectId: params.projectId,
      organizationId: params.organizationId,
      environmentType: "DEVELOPMENT",
      isTest: false,
      taskEventStore: "taskEvent",
      runTags: params.runTags ?? ["alpha", "beta"],
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      completedAt: new Date("2024-01-01T00:01:00.000Z"),
    },
  });
}

async function seedBatch(
  prisma: PrismaClient,
  params: { id: string; friendlyId: string; runtimeEnvironmentId: string }
) {
  return prisma.batchTaskRun.create({
    data: {
      id: params.id,
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      status: "PENDING",
    },
  });
}

function makeBatchDeps(
  overrides: {
    splitEnabled?: boolean;
    newReplica?: PrismaClient;
    newWriter?: PrismaClient;
    legacyWriter?: PrismaClient;
    legacyReplica?: PrismaClient;
  } & { single?: PrismaClient }
): BatchCompletionDeps & { tryCompleteBatchCalls: string[] } {
  const single = overrides.single;
  const tryCompleteBatchCalls: string[] = [];
  return {
    splitEnabled: overrides.splitEnabled ?? false,
    newReplica: (overrides.newReplica ?? single)!,
    newWriter: (overrides.newWriter ?? single)!,
    legacyWriter: (overrides.legacyWriter ?? single)!,
    tryCompleteBatch: async (batchId: string) => {
      tryCompleteBatchCalls.push(batchId);
    },
    tryCompleteBatchCalls,
  };
}

function failure(index: number, errorCode: string, extra?: Record<string, unknown>) {
  return {
    index,
    taskIdentifier: "my-task",
    payload: '{"item":' + index + "}",
    options: { foo: "bar" },
    error: `error ${index}`,
    errorCode,
    timestamp: Date.now(),
    ...extra,
  };
}

describe("runEngineHandlers read-through", () => {
  // A NEW run resolves via read-through against the new store.
  containerTest("event read resolves a NEW run via read-through", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { organization, project, environment } = await seedEnvironment(prisma, "a");
    await seedTaskRun(prisma, {
      id: "run_new_a",
      friendlyId: "run_friendly_a",
      organizationId: organization.id,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      runTags: ["x", "y"],
    });

    const deps: EventReadDeps = {
      store,
      newReplica: prisma,
      legacyReplica: prisma,
      splitEnabled: false,
    };

    const run = await readRunForEvent("run_new_a", environment.id, EVENT_SELECT, deps);

    expect(run).not.toBeNull();
    expect(run!.id).toBe("run_new_a");
    expect(run!.friendlyId).toBe("run_friendly_a");
    expect(run!.runTags).toEqual(["x", "y"]);
    expect(run!.organizationId).toBe(organization.id);
    expect(run!.taskEventStore).toBe("taskEvent");
  });

  // Single-DB short-circuit — readLegacy must never be invoked.
  containerTest("single-DB short-circuit never touches a legacy handle", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const { organization, project, environment } = await seedEnvironment(prisma, "c");
    await seedTaskRun(prisma, {
      id: "run_single_c",
      friendlyId: "run_friendly_c",
      organizationId: organization.id,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
    });

    // A legacy replica that THROWS if read — proves the short-circuit.
    const exploding = new Proxy(
      {},
      {
        get() {
          throw new Error("legacy replica must not be touched in single-DB mode");
        },
      }
    ) as unknown as PrismaClient;

    const deps: EventReadDeps = {
      store,
      newReplica: prisma,
      legacyReplica: exploding,
      splitEnabled: false,
    };

    const run = await readRunForEvent("run_single_c", environment.id, EVENT_SELECT, deps);
    expect(run!.id).toBe("run_single_c");
  });

  // readRunForEventOrThrow reproduces the not-found-as-error semantics.
  containerTest("readRunForEventOrThrow throws on a missing run", async ({ prisma }) => {
    const store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    await seedEnvironment(prisma, "nf");

    const deps: EventReadDeps = {
      store,
      newReplica: prisma,
      legacyReplica: prisma,
      splitEnabled: false,
    };

    await expect(
      readRunForEventOrThrow("run_missing", "env_x", EVENT_SELECT, deps)
    ).rejects.toThrow();

    // Nullable helper returns null instead of throwing for the same input.
    const run = await readRunForEvent("run_missing", "env_x", EVENT_SELECT, deps);
    expect(run).toBeNull();
  });
});

describe("runEngineHandlers read-through cross-version", () => {
  // An OLD in-retention run is served off the LEGACY REPLICA only, and the legacy
  // primary/writer is structurally absent.
  heteroPostgresTest(
    "event read resolves an OLD in-retention run via the legacy replica",
    async ({ prisma14, prisma17 }) => {
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });

      const legacySeed = await seedEnvironment(prisma14, "b14");
      // A 25-char cuid id classifies as LEGACY so read-through probes new, misses,
      // then falls back to the legacy replica.
      const legacyRunId = "c".repeat(25);
      const seededRow = await seedTaskRun(prisma14, {
        id: legacyRunId,
        friendlyId: "run_friendly_b",
        organizationId: legacySeed.organization.id,
        projectId: legacySeed.project.id,
        runtimeEnvironmentId: legacySeed.environment.id,
        runTags: ["legacy", "tag"],
      });

      // The read uses the NEW store for the new-DB probe and the LEGACY store for
      // the replica fallback, so a hit can only come from the legacy replica.
      let legacyReplicaUsed = false;
      // A store facade that routes the read to the legacy store when handed the
      // legacy client and the new store otherwise — both real DBs, no mocks.
      const routedStore = {
        ...newStore,
        findRun: ((where: any, args: any, client: any) => {
          if (client === prisma14) {
            legacyReplicaUsed = true;
            return legacyStore.findRun(where, args, client);
          }
          return newStore.findRun(where, args, client);
        }) as typeof newStore.findRun,
      } as PostgresRunStore;
      const routedDeps: EventReadDeps = {
        store: routedStore,
        newReplica: prisma17,
        legacyReplica: prisma14,
        splitEnabled: true,
      };

      const run = await readRunForEvent(
        legacyRunId,
        legacySeed.environment.id,
        EVENT_SELECT,
        routedDeps
      );

      expect(legacyReplicaUsed).toBe(true);
      expect(run).not.toBeNull();
      expect(run!.id).toBe(legacyRunId);
      // Byte-identity of the enrichment select across the legacy<->new boundary:
      // re-read the same row on the legacy replica directly and deep-equal it.
      const direct = await legacyStore.findRun(
        { id: legacyRunId },
        { select: EVENT_SELECT },
        prisma14
      );
      expect(run).toEqual(direct);
      expect(run!.runTags).toEqual(["legacy", "tag"]);
      expect(seededRow.id).toBe(legacyRunId);

      // The new DB has no such run.
      const onNew = await newStore.findRun({ id: legacyRunId }, { select: EVENT_SELECT }, prisma17);
      expect(onNew).toBeNull();
    }
  );
});

describe("runEngineHandlers batch completion", () => {
  // Tests D + F: the txn commits whole on a single run-ops writer; rolls back atomically.
  containerTest("batch txn commits whole on the run-ops writer", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma, "d");
    const batchId = "c".repeat(25);
    await seedBatch(prisma, {
      id: batchId,
      friendlyId: "batch_friendly_d",
      runtimeEnvironmentId: environment.id,
    });

    const deps = makeBatchDeps({ single: prisma, splitEnabled: false });
    const result: CompleteBatchResult = {
      batchId,
      runIds: ["run_friendly_1", "run_friendly_2"],
      successfulRunCount: 2,
      failedRunCount: 1,
      failures: [failure(0, "TRIGGER_ERROR", { options: { nested: { a: 1, b: [2, 3] } } })],
    };

    await handleBatchCompletion(result, deps);

    const batch = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("PARTIAL_FAILED");
    expect(batch.runIds).toEqual(["run_friendly_1", "run_friendly_2"]);
    expect(batch.successfulRunCount).toBe(2);
    expect(batch.failedRunCount).toBe(1);
    expect(batch.processingCompletedAt).not.toBeNull();

    const errors = await prisma.batchTaskRunError.findMany({ where: { batchTaskRunId: batchId } });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errorCode).toBe("TRIGGER_ERROR");
    // JSON round-trip of options.
    expect(errors[0]!.options).toEqual({ nested: { a: 1, b: [2, 3] } });

    // PARTIAL_FAILED (not ABORTED) -> tryCompleteBatch is invoked.
    expect(deps.tryCompleteBatchCalls).toEqual([batchId]);
  });

  // Atomicity: if the createMany fails, the update rolls back too.
  containerTest("batch txn rolls back the update when createMany fails", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma, "rb");
    const batchId = "d".repeat(25);
    await seedBatch(prisma, {
      id: batchId,
      friendlyId: "batch_friendly_rb",
      runtimeEnvironmentId: environment.id,
    });

    const deps = makeBatchDeps({ single: prisma, splitEnabled: false });
    // A failure with a null taskIdentifier violates the NOT NULL constraint inside
    // the createMany, forcing the whole transaction to roll back.
    const result = {
      batchId,
      runIds: ["run_friendly_1"],
      successfulRunCount: 0,
      failedRunCount: 1,
      failures: [
        { index: 0, taskIdentifier: null as any, payload: "{}", error: "boom", timestamp: 1 },
      ],
    } as unknown as CompleteBatchResult;

    await expect(handleBatchCompletion(result, deps)).rejects.toThrow();

    // The update must NOT have committed — status stays PENDING from the seed.
    const batch = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("PENDING");
    expect(batch.processingCompletedAt).toBeNull();
  });

  // Callback retry is idempotent via skipDuplicates.
  containerTest("batch txn is idempotent on callback retry", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma, "e");
    const batchId = "e".repeat(25);
    await seedBatch(prisma, {
      id: batchId,
      friendlyId: "batch_friendly_e",
      runtimeEnvironmentId: environment.id,
    });

    const deps = makeBatchDeps({ single: prisma, splitEnabled: false });
    const result: CompleteBatchResult = {
      batchId,
      runIds: [],
      successfulRunCount: 0,
      failedRunCount: 2,
      failures: [failure(0, "TRIGGER_ERROR"), failure(1, "TRIGGER_ERROR")],
    };

    await handleBatchCompletion(result, deps);
    await handleBatchCompletion(result, deps);

    const errors = await prisma.batchTaskRunError.findMany({ where: { batchTaskRunId: batchId } });
    expect(errors).toHaveLength(2);
  });

  // Aggregate fast-path collapses same-errorCode failures to one row.
  containerTest("aggregate fast-path collapses queue-size-limit failures", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma, "i");
    const batchId = "f".repeat(25);
    await seedBatch(prisma, {
      id: batchId,
      friendlyId: "batch_friendly_i",
      runtimeEnvironmentId: environment.id,
    });

    const deps = makeBatchDeps({ single: prisma, splitEnabled: false });
    const result: CompleteBatchResult = {
      batchId,
      runIds: [],
      successfulRunCount: 0,
      failedRunCount: 3,
      failures: [
        failure(5, "QUEUE_SIZE_LIMIT_EXCEEDED"),
        failure(6, "QUEUE_SIZE_LIMIT_EXCEEDED"),
        failure(7, "QUEUE_SIZE_LIMIT_EXCEEDED"),
      ],
    };

    await handleBatchCompletion(result, deps);

    const errors = await prisma.batchTaskRunError.findMany({ where: { batchTaskRunId: batchId } });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.index).toBe(5);
    expect(errors[0]!.error).toContain("(3 items in this batch failed with the same error)");
  });

  // ABORTED status does not call tryCompleteBatch.
  containerTest("ABORTED batch does not call tryCompleteBatch", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma, "ab");
    const batchId = "g".repeat(25);
    await seedBatch(prisma, {
      id: batchId,
      friendlyId: "batch_friendly_ab",
      runtimeEnvironmentId: environment.id,
    });

    const deps = makeBatchDeps({ single: prisma, splitEnabled: false });
    const result: CompleteBatchResult = {
      batchId,
      runIds: [],
      successfulRunCount: 0,
      failedRunCount: 1,
      failures: [failure(0, "TRIGGER_ERROR")],
    };

    await handleBatchCompletion(result, deps);

    const batch = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("ABORTED");
    expect(batch.completedAt).not.toBeNull();
    expect(deps.tryCompleteBatchCalls).toEqual([]);
  });

  // A successful (no-failure) batch is PENDING and calls tryCompleteBatch.
  containerTest("successful batch is PENDING and calls tryCompleteBatch", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma, "ok");
    const batchId = "h".repeat(25);
    await seedBatch(prisma, {
      id: batchId,
      friendlyId: "batch_friendly_ok",
      runtimeEnvironmentId: environment.id,
    });

    const deps = makeBatchDeps({ single: prisma, splitEnabled: false });
    const result: CompleteBatchResult = {
      batchId,
      runIds: ["run_friendly_1"],
      successfulRunCount: 1,
      failedRunCount: 0,
      failures: [],
    };

    await handleBatchCompletion(result, deps);

    const batch = await prisma.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe("PENDING");
    expect(deps.tryCompleteBatchCalls).toEqual([batchId]);
  });
});

describe("runEngineHandlers batch residency routing", () => {
  // True single-DB invariant: the topology's cpFallback makes newReplica and
  // legacyWriter the SAME control-plane client, so the probe always resolves to
  // that one client regardless of where length-classification would guess.
  containerTest("true single-DB resolves to the single client", async ({ prisma }) => {
    const { environment } = await seedEnvironment(prisma, "single");
    const batchId = "s".repeat(25);
    await seedBatch(prisma, {
      id: batchId,
      friendlyId: "batch_friendly_single",
      runtimeEnvironmentId: environment.id,
    });

    const writer = await resolveBatchRunOpsWriter(batchId, {
      newReplica: prisma,
      newWriter: prisma,
      legacyWriter: prisma,
    });
    expect(writer).toBe(prisma);
  });

  // A legacy-resident batch (row only on the legacy DB) commits on the LEGACY writer;
  // the NEW DB is left with zero rows for the batch.
  heteroPostgresTest(
    "legacy-resident batch routes to the LEGACY writer, new DB untouched",
    async ({ prisma14, prisma17 }) => {
      const legacySeed = await seedEnvironment(prisma14, "g14");
      const batchId = "c".repeat(25);
      await seedBatch(prisma14, {
        id: batchId,
        friendlyId: "batch_friendly_g",
        runtimeEnvironmentId: legacySeed.environment.id,
      });

      // The probe misses on new (the new DB has no such batch) and resolves the legacy writer.
      const writer = await resolveBatchRunOpsWriter(batchId, {
        newReplica: prisma17,
        newWriter: prisma17,
        legacyWriter: prisma14,
      });
      expect(writer).toBe(prisma14);

      const deps: BatchCompletionDeps = {
        splitEnabled: true,
        newReplica: prisma17,
        newWriter: prisma17,
        legacyWriter: prisma14,
        tryCompleteBatch: async () => {},
      };

      const result: CompleteBatchResult = {
        batchId,
        runIds: ["run_friendly_1"],
        successfulRunCount: 1,
        failedRunCount: 1,
        failures: [failure(0, "TRIGGER_ERROR")],
      };

      await handleBatchCompletion(result, deps);

      // Committed on the legacy DB.
      const legacyBatch = await prisma14.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
      expect(legacyBatch.status).toBe("PARTIAL_FAILED");
      const legacyErrors = await prisma14.batchTaskRunError.findMany({
        where: { batchTaskRunId: batchId },
      });
      expect(legacyErrors).toHaveLength(1);

      // The new DB has zero rows for this batch — no misroute.
      const onNew = await prisma17.batchTaskRun.findMany({ where: { id: batchId } });
      expect(onNew).toHaveLength(0);
      const newErrors = await prisma17.batchTaskRunError.findMany({
        where: { batchTaskRunId: batchId },
      });
      expect(newErrors).toHaveLength(0);
    }
  );

  // Regression: the real "run-ops DB connected, split flag off" state. splitEnabled
  // is false, yet newWriter is a DISTINCT (empty) DB while the batch lives on legacy.
  // Old code wrote to newWriter -> "No record was found for an update" -> batch hangs.
  heteroPostgresTest(
    "split-off connected-but-off: legacy-resident batch routes to LEGACY, not newWriter",
    async ({ prisma14, prisma17 }) => {
      const legacySeed = await seedEnvironment(prisma14, "off14");
      const batchId = "c".repeat(25);
      await seedBatch(prisma14, {
        id: batchId,
        friendlyId: "batch_friendly_off",
        runtimeEnvironmentId: legacySeed.environment.id,
      });

      const deps: BatchCompletionDeps = {
        splitEnabled: false,
        newReplica: prisma17,
        newWriter: prisma17,
        legacyWriter: prisma14,
        tryCompleteBatch: async () => {},
      };

      const result: CompleteBatchResult = {
        batchId,
        runIds: ["run_friendly_1"],
        successfulRunCount: 1,
        failedRunCount: 1,
        failures: [failure(0, "TRIGGER_ERROR")],
      };

      await handleBatchCompletion(result, deps);

      // Committed on the legacy DB; the new DB (the distinct newWriter) untouched.
      const legacyBatch = await prisma14.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
      expect(legacyBatch.status).toBe("PARTIAL_FAILED");
      expect(legacyBatch.processingCompletedAt).not.toBeNull();
      const legacyErrors = await prisma14.batchTaskRunError.findMany({
        where: { batchTaskRunId: batchId },
      });
      expect(legacyErrors).toHaveLength(1);

      const onNew = await prisma17.batchTaskRun.findMany({ where: { id: batchId } });
      expect(onNew).toHaveLength(0);
      const newErrors = await prisma17.batchTaskRunError.findMany({
        where: { batchTaskRunId: batchId },
      });
      expect(newErrors).toHaveLength(0);
    }
  );

  // A new batch (row only on the new DB) commits on the NEW writer; the LEGACY DB is untouched.
  heteroPostgresTest(
    "new batch routes to the NEW writer, legacy DB untouched",
    async ({ prisma14, prisma17 }) => {
      const newSeed = await seedEnvironment(prisma17, "h17");
      const batchId = "d".repeat(25);
      await seedBatch(prisma17, {
        id: batchId,
        friendlyId: "batch_friendly_h",
        runtimeEnvironmentId: newSeed.environment.id,
      });

      const writer = await resolveBatchRunOpsWriter(batchId, {
        newReplica: prisma17,
        newWriter: prisma17,
        legacyWriter: prisma14,
      });
      expect(writer).toBe(prisma17);

      const deps: BatchCompletionDeps = {
        splitEnabled: true,
        newReplica: prisma17,
        newWriter: prisma17,
        legacyWriter: prisma14,
        tryCompleteBatch: async () => {},
      };

      const result: CompleteBatchResult = {
        batchId,
        runIds: ["run_friendly_1"],
        successfulRunCount: 1,
        failedRunCount: 1,
        failures: [failure(0, "TRIGGER_ERROR", { options: { json: { deep: [1, 2, 3] } } })],
      };

      await handleBatchCompletion(result, deps);

      const newBatch = await prisma17.batchTaskRun.findFirstOrThrow({ where: { id: batchId } });
      expect(newBatch.status).toBe("PARTIAL_FAILED");
      const newErrors = await prisma17.batchTaskRunError.findMany({
        where: { batchTaskRunId: batchId },
      });
      expect(newErrors).toHaveLength(1);
      // Batch JSON round-trip on the new DB.
      expect(newErrors[0]!.options).toEqual({ json: { deep: [1, 2, 3] } });

      // The legacy DB is untouched.
      const onLegacy = await prisma14.batchTaskRun.findMany({ where: { id: batchId } });
      expect(onLegacy).toHaveLength(0);
    }
  );
});

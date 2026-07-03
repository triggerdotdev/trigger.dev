import { heteroPostgresTest, heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient, TaskRunStatus } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput } from "./types.js";

// 25-char internal id → cuid → LEGACY; 27-char internal id → ksuid → NEW.
const CUID_25 = "c".repeat(25);
const KSUID_27 = "k".repeat(27);

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

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  taskIdentifier: string;
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
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: params.taskIdentifier,
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: ["alpha", "beta"],
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
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

// Strip the prisma-managed/connection-volatile fields so two rows born on different
// physical DBs can be compared field-for-field for cross-version byte-identity.
function normalizeRow(row: Record<string, unknown>) {
  const { id, createdAt, updatedAt, ...rest } = row as {
    id: unknown;
    createdAt: unknown;
    updatedAt: unknown;
  } & Record<string, unknown>;
  return rest;
}

describe("RoutingRunStore (TaskRun-core)", () => {
  // Test A: identical CreateRunInput through a PostgresRunStore over PG14 and over PG17
  // yields deep-equal persisted rows (cross-version byte-identity).
  heteroPostgresTest(
    "TaskRun create/find round-trip is byte-identical across PG14 and PG17",
    async ({ prisma14, prisma17 }) => {
      const store14 = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const store17 = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const seed14 = await seedEnvironment(prisma14, "a14");
      const seed17 = await seedEnvironment(prisma17, "a17");

      const runId = "run_roundtrip_1";
      await store14.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_friendly_1",
          taskIdentifier: "my-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );
      await store17.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_friendly_1",
          taskIdentifier: "my-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        })
      );

      const row14 = await store14.findRun({ id: runId }, prisma14);
      const row17 = await store17.findRun({ id: runId }, prisma17);

      expect(row14).not.toBeNull();
      expect(row17).not.toBeNull();

      // Drop env/project/org ids (differ per DB seed) plus the prisma-managed fields,
      // then assert every remaining persisted column is identical across versions.
      const strip = (row: Record<string, unknown>) => {
        const r = { ...normalizeRow(row) };
        delete r.runtimeEnvironmentId;
        delete r.projectId;
        delete r.organizationId;
        return r;
      };
      expect(strip(row14 as Record<string, unknown>)).toEqual(
        strip(row17 as Record<string, unknown>)
      );
      // The payload / JSON / array / scalar columns specifically survive byte-identically.
      expect(row14!.payload).toBe('{"hello":"world"}');
      expect(row17!.payload).toBe('{"hello":"world"}');
      expect(row14!.runTags).toEqual(["alpha", "beta"]);
      expect(row17!.runTags).toEqual(["alpha", "beta"]);
      expect(row14!.traceContext).toEqual({ trace: "ctx" });
      expect(row17!.traceContext).toEqual({ trace: "ctx" });
      expect(row14!.createdAt.toISOString()).toBe(row17!.createdAt.toISOString());
    }
  );

  // Test B: a collation-sensitive ORDER BY pinned to the shared ICU collation returns
  // the identical sequence on PG14 and PG17 (keyset-cursor / pagination parity guard).
  heteroPostgresTest(
    "ORDER BY pinned to the shared ICU collation is identical across PG14 and PG17",
    async ({ prisma14, prisma17, pinnedCollation }) => {
      const store14 = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const store17 = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const seed14 = await seedEnvironment(prisma14, "b14");
      const seed17 = await seedEnvironment(prisma17, "b17");

      // Mixed-case, punctuated, accented values where C-locale vs ICU sort differs.
      const friendlyIds = [
        "run_Zebra",
        "run_apple",
        "run_Apple",
        "run_éclair",
        "run_banana",
        "run__underscore",
      ];

      let n = 0;
      for (const fid of friendlyIds) {
        const idSuffix = `${n++}`;
        await store14.createRun(
          buildCreateRunInput({
            runId: `run_b14_${idSuffix}`,
            friendlyId: fid,
            taskIdentifier: fid,
            organizationId: seed14.organization.id,
            projectId: seed14.project.id,
            runtimeEnvironmentId: seed14.environment.id,
          })
        );
        await store17.createRun(
          buildCreateRunInput({
            runId: `run_b17_${idSuffix}`,
            friendlyId: fid,
            taskIdentifier: fid,
            organizationId: seed17.organization.id,
            projectId: seed17.project.id,
            runtimeEnvironmentId: seed17.environment.id,
          })
        );
      }

      // Prisma `orderBy` cannot express an explicit COLLATE, so prove column-level
      // collation parity via $queryRaw with the pinned ICU collation on each client.
      const orderedFriendlyIds = async (client: PrismaClient) => {
        const rows = await client.$queryRawUnsafe<{ friendlyId: string }[]>(
          `SELECT "friendlyId" FROM "TaskRun" ORDER BY "friendlyId" COLLATE "${pinnedCollation}" ASC`
        );
        return rows.map((r) => r.friendlyId);
      };

      const ordered14 = await orderedFriendlyIds(prisma14);
      const ordered17 = await orderedFriendlyIds(prisma17);

      expect(ordered14).toEqual(ordered17);
      expect(ordered14).toHaveLength(friendlyIds.length);
    }
  );

  // Test C: the router writes new runs to NEW and routes existing-id finds by residency.
  heteroPostgresTest(
    "RoutingRunStore selects the underlying store by residency",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "c14");
      const seed17 = await seedEnvironment(prisma17, "c17");

      // (i) createRun lands on NEW, never on LEGACY.
      const bornId = "run_born_on_new";
      await router.createRun(
        buildCreateRunInput({
          runId: bornId,
          friendlyId: "run_born",
          taskIdentifier: "my-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        })
      );
      expect(await prisma17.taskRun.findUnique({ where: { id: bornId } })).not.toBeNull();
      expect(await prisma14.taskRun.findUnique({ where: { id: bornId } })).toBeNull();

      // (ii) seed a cuid-length (LEGACY) row on the legacy DB and a ksuid-length (NEW) row on
      // the new DB, then prove residency selection via ownerEngine length classification.
      const legacyRunId = `run_${CUID_25}`;
      const newRunId = `run_${KSUID_27}`;
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: legacyRunId,
          friendlyId: "run_legacy",
          taskIdentifier: "legacy-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );
      await newStore.createRun(
        buildCreateRunInput({
          runId: newRunId,
          friendlyId: "run_new",
          taskIdentifier: "new-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        })
      );

      const legacyFound = await router.findRun({ id: legacyRunId });
      const newFound = await router.findRun({ id: newRunId });

      expect(legacyFound?.id).toBe(legacyRunId);
      expect(legacyFound?.taskIdentifier).toBe("legacy-task");
      expect(newFound?.id).toBe(newRunId);
      expect(newFound?.taskIdentifier).toBe("new-task");

      // The LEGACY-residency id must NOT resolve from the NEW store, and vice versa.
      expect(await newStore.findRun({ id: legacyRunId })).toBeNull();
      expect(await legacyStore.findRun({ id: newRunId })).toBeNull();
    }
  );

  // Test C2: create routes by the MINTED id-kind, not hardcoded NEW.
  // A cuid (LEGACY) child must be physically created on LEGACY, never NEW.
  heteroPostgresTest(
    "createRun routes by minted residency: a cuid child is born on LEGACY",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "c2_14");

      // A cuid-length (LEGACY-residency) child id — e.g. an inherited-residency child of a legacy parent.
      const legacyChildId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId: legacyChildId,
          friendlyId: "run_legacy_child",
          taskIdentifier: "legacy-child-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      // Born on LEGACY, NOT on NEW.
      expect(await prisma14.taskRun.findUnique({ where: { id: legacyChildId } })).not.toBeNull();
      expect(await prisma17.taskRun.findUnique({ where: { id: legacyChildId } })).toBeNull();
    }
  );

  // Test C4: write routing is pure id-shape — a cuid run's writes go to LEGACY.
  heteroPostgresTest(
    "writes route by id-shape (LEGACY for cuid)",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const legacyId = `run_${CUID_25}`;
      const seed14 = await seedEnvironment(prisma14, "c4_14");
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: legacyId,
          friendlyId: "run_legacy_write",
          taskIdentifier: "legacy-write-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      const result = await router.updateMetadata(
        legacyId,
        {
          metadata: '{"y":2}',
          metadataVersion: { increment: 1 },
          updatedAt: new Date("2024-02-02T00:00:00.000Z"),
        },
        {}
      );
      expect(result.count).toBe(1);
      const onLegacy = await prisma14.taskRun.findUnique({ where: { id: legacyId } });
      expect(onLegacy?.metadata).toBe('{"y":2}');
    }
  );

  // Test D: single-DB / passthrough — both slots are the same store over one client.
  heteroPostgresTest("single-DB binds one client (passthrough)", async ({ prisma14, prisma17 }) => {
    const store = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
    const router = new RoutingRunStore({ new: store, legacy: store });

    const seed = await seedEnvironment(prisma14, "d14");

    // Use a ksuid-length (NEW-residency) id to exercise the route; in single-DB both
    // slots are the same store, so the round-trip must succeed on the one client.
    const runId = `run_${KSUID_27}`;
    await router.createRun(
      buildCreateRunInput({
        runId,
        friendlyId: "run_passthrough",
        taskIdentifier: "passthrough-task",
        organizationId: seed.organization.id,
        projectId: seed.project.id,
        runtimeEnvironmentId: seed.environment.id,
      })
    );

    const found = await router.findRun({ id: runId });
    expect(found?.id).toBe(runId);
    expect(found?.taskIdentifier).toBe("passthrough-task");

    // The single client is the only one that holds the row; the second fixture DB was
    // never touched by the router (no second connection opened).
    expect(await prisma14.taskRun.findUnique({ where: { id: runId } })).not.toBeNull();
    expect(await prisma17.taskRun.findUnique({ where: { id: runId } })).toBeNull();
  });
});

describe("BatchTaskRun group", () => {
  function batchCreateData(params: {
    id: string;
    friendlyId: string;
    runtimeEnvironmentId: string;
    runCount: number;
  }) {
    return {
      id: params.id,
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      runCount: params.runCount,
      runIds: [] as string[],
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      options: { foo: "bar" },
      batchVersion: "runengine:v1",
    };
  }

  // Create/find/update round-trip on PostgresRunStore, asserted byte-identical across
  // PG14 and PG17 (the text[] runIds array + JSON payload/options survive cross-version).
  heteroPostgresTest(
    "BatchTaskRun create/find/update round-trip is byte-identical across PG14 and PG17",
    async ({ prisma14, prisma17 }) => {
      const store14 = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const store17 = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });

      const seed14 = await seedEnvironment(prisma14, "batcha14");
      const seed17 = await seedEnvironment(prisma17, "batcha17");

      const batchId = "batch_roundtrip_1";
      const created14 = await store14.createBatchTaskRun(
        batchCreateData({
          id: batchId,
          friendlyId: "batch_friendly_1",
          runtimeEnvironmentId: seed14.environment.id,
          runCount: 2,
        })
      );
      const _created17 = await store17.createBatchTaskRun(
        batchCreateData({
          id: batchId,
          friendlyId: "batch_friendly_1",
          runtimeEnvironmentId: seed17.environment.id,
          runCount: 2,
        })
      );

      // create returns the full default row (the onBatchTaskRunCreated event shape).
      expect(created14.runCount).toBe(2);
      expect(created14.batchVersion).toBe("runengine:v1");
      expect(created14.runIds).toEqual([]);

      // find defaults to the primary client (worker reads the just-written row).
      const found14 = await store14.findBatchTaskRunById(batchId);
      const found17 = await store17.findBatchTaskRunById(batchId);
      expect(found14?.id).toBe(batchId);
      expect(found17?.id).toBe(batchId);

      const strip = (row: Record<string, unknown>) => {
        const { id, createdAt, updatedAt, runtimeEnvironmentId, ...rest } = row;
        return rest;
      };
      expect(strip(found14 as Record<string, unknown>)).toEqual(
        strip(found17 as Record<string, unknown>)
      );
      expect(found14!.payload).toBe('{"hello":"world"}');
      expect(found17!.payload).toBe('{"hello":"world"}');
      expect(found14!.options).toEqual({ foo: "bar" });
      expect(found17!.options).toEqual({ foo: "bar" });

      // update pushes runIds + increments processingJobsCount; the select narrows the row.
      const updated14 = await store14.updateBatchTaskRun({
        where: { id: batchId },
        data: { runIds: { push: ["run_a", "run_b"] }, processingJobsCount: { increment: 2 } },
        select: { processingJobsCount: true, runCount: true },
      });
      const updated17 = await store17.updateBatchTaskRun({
        where: { id: batchId },
        data: { runIds: { push: ["run_a", "run_b"] }, processingJobsCount: { increment: 2 } },
        select: { processingJobsCount: true, runCount: true },
      });
      expect(updated14).toEqual({ processingJobsCount: 2, runCount: 2 });
      expect(updated17).toEqual({ processingJobsCount: 2, runCount: 2 });

      // the runIds array survived the push on both versions.
      const reread14 = await store14.findBatchTaskRunById(batchId);
      const reread17 = await store17.findBatchTaskRunById(batchId);
      expect(reread14!.runIds).toEqual(["run_a", "run_b"]);
      expect(reread17!.runIds).toEqual(["run_a", "run_b"]);
    }
  );

  // Unclassifiable id falls back to NEW; find probe also hits NEW first, so round-trip stays on NEW.
  heteroPostgresTest(
    "RoutingRunStore routes BatchTaskRun create/find/update to NEW",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed17 = await seedEnvironment(prisma17, "batchb17");

      const batchId = "batch_born_on_new";
      await router.createBatchTaskRun(
        batchCreateData({
          id: batchId,
          friendlyId: "batch_born",
          runtimeEnvironmentId: seed17.environment.id,
          runCount: 1,
        })
      );

      // born on NEW, never on LEGACY.
      expect(await prisma17.batchTaskRun.findUnique({ where: { id: batchId } })).not.toBeNull();
      expect(await prisma14.batchTaskRun.findUnique({ where: { id: batchId } })).toBeNull();

      // find + update route to NEW as well.
      expect((await router.findBatchTaskRunById(batchId))?.id).toBe(batchId);
      const updated = await router.updateBatchTaskRun({
        where: { id: batchId },
        data: { runIds: { push: ["run_x"] }, processingJobsCount: { increment: 1 } },
        select: { processingJobsCount: true, runCount: true },
      });
      expect(updated).toEqual({ processingJobsCount: 1, runCount: 1 });
      expect(await prisma14.batchTaskRun.findUnique({ where: { id: batchId } })).toBeNull();
    }
  );

  // Single-DB passthrough: both slots are the same store over one client.
  heteroPostgresTest(
    "single-DB binds one client for BatchTaskRun (passthrough)",
    async ({ prisma14, prisma17 }) => {
      const store = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const router = new RoutingRunStore({ new: store, legacy: store });

      const seed = await seedEnvironment(prisma14, "batchd14");

      const batchId = "batch_passthrough";
      await router.createBatchTaskRun(
        batchCreateData({
          id: batchId,
          friendlyId: "batch_passthrough",
          runtimeEnvironmentId: seed.environment.id,
          runCount: 1,
        })
      );

      expect((await router.findBatchTaskRunById(batchId))?.id).toBe(batchId);
      expect(await prisma14.batchTaskRun.findUnique({ where: { id: batchId } })).not.toBeNull();
      expect(await prisma17.batchTaskRun.findUnique({ where: { id: batchId } })).toBeNull();
    }
  );

  heteroPostgresTest(
    "findBatchTaskRunById routes ksuid→NEW and cuid→LEGACY",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "p8a_cuid14");
      const seed17 = await seedEnvironment(prisma17, "p8a_ksuid17");

      await newStore.createBatchTaskRun(
        batchCreateData({
          id: KSUID_27,
          friendlyId: "batch_ksuid_p8a",
          runtimeEnvironmentId: seed17.environment.id,
          runCount: 1,
        })
      );
      await legacyStore.createBatchTaskRun(
        batchCreateData({
          id: CUID_25,
          friendlyId: "batch_cuid_p8a",
          runtimeEnvironmentId: seed14.environment.id,
          runCount: 1,
        })
      );

      expect((await router.findBatchTaskRunById(KSUID_27))?.id).toBe(KSUID_27);
      expect((await router.findBatchTaskRunById(CUID_25))?.id).toBe(CUID_25);
    }
  );

  heteroPostgresTest(
    "updateBatchTaskRun routes cuid→LEGACY and ksuid→NEW",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "p8a_upd14");
      const seed17 = await seedEnvironment(prisma17, "p8a_upd17");

      const ksuidBatchId = `${KSUID_27.slice(0, -1)}u`;
      const cuidBatchId = `${CUID_25.slice(0, -1)}u`;

      await newStore.createBatchTaskRun(
        batchCreateData({
          id: ksuidBatchId,
          friendlyId: "batch_ksuid_upd",
          runtimeEnvironmentId: seed17.environment.id,
          runCount: 2,
        })
      );
      await legacyStore.createBatchTaskRun(
        batchCreateData({
          id: cuidBatchId,
          friendlyId: "batch_cuid_upd",
          runtimeEnvironmentId: seed14.environment.id,
          runCount: 2,
        })
      );

      const updNew = await router.updateBatchTaskRun({
        where: { id: ksuidBatchId },
        data: { processingJobsCount: { increment: 1 } },
        select: { processingJobsCount: true, runCount: true },
      });
      expect(updNew).toEqual({ processingJobsCount: 1, runCount: 2 });
      expect(await prisma14.batchTaskRun.findUnique({ where: { id: ksuidBatchId } })).toBeNull();

      const updLegacy = await router.updateBatchTaskRun({
        where: { id: cuidBatchId },
        data: { processingJobsCount: { increment: 1 } },
        select: { processingJobsCount: true, runCount: true },
      });
      expect(updLegacy).toEqual({ processingJobsCount: 1, runCount: 2 });
      expect(await prisma17.batchTaskRun.findUnique({ where: { id: cuidBatchId } })).toBeNull();
    }
  );

  heteroPostgresTest(
    "findBatchTaskRunById({ include: { items: true } }) returns BatchTaskRunItems",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed17 = await seedEnvironment(prisma17, "p8a_inc17");
      const ksuidBatchId = `${KSUID_27.slice(0, -2)}in`;

      await newStore.createBatchTaskRun(
        batchCreateData({
          id: ksuidBatchId,
          friendlyId: "batch_inc_p8a",
          runtimeEnvironmentId: seed17.environment.id,
          runCount: 1,
        })
      );

      const runId = `${KSUID_27.slice(0, -3)}run`;
      await prisma17.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: `run_${runId}`,
          runtimeEnvironmentId: seed17.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          taskIdentifier: "inc-task",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t1",
          spanId: "s1",
          queue: "task/inc-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: ksuidBatchId, taskRunId: runId, status: "PENDING" },
      });

      const withItems = await router.findBatchTaskRunById(ksuidBatchId, {
        include: { items: true },
      });
      expect(withItems?.items).toBeDefined();
      expect(withItems?.items?.length).toBe(1);
      expect(withItems?.items?.[0]?.taskRunId).toBe(runId);
    }
  );

  heteroPostgresTest(
    "createBatchTaskRun routes ksuid→NEW and cuid→LEGACY",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "p8c_cuid14");
      const seed17 = await seedEnvironment(prisma17, "p8c_ksuid17");

      const ksuidBatchId = `${KSUID_27.slice(0, -2)}c1`;
      const cuidBatchId = `${CUID_25.slice(0, -2)}c1`;

      await router.createBatchTaskRun(
        batchCreateData({
          id: ksuidBatchId,
          friendlyId: "batch_p8c_ksuid",
          runtimeEnvironmentId: seed17.environment.id,
          runCount: 1,
        })
      );
      expect(
        await prisma17.batchTaskRun.findUnique({ where: { id: ksuidBatchId } })
      ).not.toBeNull();
      expect(await prisma14.batchTaskRun.findUnique({ where: { id: ksuidBatchId } })).toBeNull();

      await router.createBatchTaskRun(
        batchCreateData({
          id: cuidBatchId,
          friendlyId: "batch_p8c_cuid",
          runtimeEnvironmentId: seed14.environment.id,
          runCount: 1,
        })
      );
      expect(await prisma14.batchTaskRun.findUnique({ where: { id: cuidBatchId } })).not.toBeNull();
      expect(await prisma17.batchTaskRun.findUnique({ where: { id: cuidBatchId } })).toBeNull();
    }
  );

  // Probe: a ksuid-id batch physically resident on LEGACY (written by batchTriggerV3 raw
  // to the control-plane) must be found; strict id-routing (ksuid→NEW only) would miss it.
  heteroPostgresTest(
    "findBatchTaskRunById probe finds ksuid-id batch resident on LEGACY (cross-residency)",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "p8c_probe14");
      const seed17 = await seedEnvironment(prisma17, "p8c_probe17");

      const ksuidOnLegacy = `${KSUID_27.slice(0, -2)}pl`;
      await legacyStore.createBatchTaskRun(
        batchCreateData({
          id: ksuidOnLegacy,
          friendlyId: "batch_p8c_probe_legacy",
          runtimeEnvironmentId: seed14.environment.id,
          runCount: 1,
        })
      );
      expect(
        await prisma14.batchTaskRun.findUnique({ where: { id: ksuidOnLegacy } })
      ).not.toBeNull();
      expect(await prisma17.batchTaskRun.findUnique({ where: { id: ksuidOnLegacy } })).toBeNull();

      expect((await router.findBatchTaskRunById(ksuidOnLegacy))?.id).toBe(ksuidOnLegacy);

      const ksuidOnNew = `${KSUID_27.slice(0, -2)}pn`;
      await newStore.createBatchTaskRun(
        batchCreateData({
          id: ksuidOnNew,
          friendlyId: "batch_p8c_probe_new",
          runtimeEnvironmentId: seed17.environment.id,
          runCount: 1,
        })
      );
      expect((await router.findBatchTaskRunById(ksuidOnNew))?.id).toBe(ksuidOnNew);
    }
  );

  // A BATCH-completion waitpoint (cuid own-id, `completedByBatchId` = ksuid batch on NEW) must be
  // born on NEW alongside its batch. On the control-plane DB (prisma14) the Waitpoint→BatchTaskRun
  // FK is enforced, so routing by the waitpoint's own cuid id-shape would land it on LEGACY and
  // FK-violate against the absent batch. The dedicated run-ops schema carries `completedByBatchId` as a scalar.
  heteroRunOpsPostgresTest(
    "createWaitpoint co-locates a BATCH-completion waitpoint with its batch on NEW",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as any,
        readOnlyPrisma: prisma17 as any,
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      // The ksuid batch lives on NEW only — never on the control-plane DB.
      const batchId = `${KSUID_27.slice(0, -2)}bw`;
      await prisma17.batchTaskRun.create({
        data: {
          id: batchId,
          friendlyId: "batch_wp_residency",
          runtimeEnvironmentId: "synthetic-env-id",
          runCount: 1,
          payload: "{}",
          payloadType: "application/json",
          batchVersion: "runengine:v1",
        },
      });

      // The waitpoint's OWN id is a cuid (→ would route to LEGACY by id-shape), but it points at
      // the NEW-resident batch. It must follow the batch, not its own id.
      const cuidWp = `waitpoint_${CUID_25}`;
      await router.createWaitpoint({
        data: {
          id: cuidWp,
          friendlyId: "waitpoint_batch_residency",
          type: "BATCH",
          idempotencyKey: batchId,
          userProvidedIdempotencyKey: false,
          completedByBatchId: batchId,
          projectId: "synthetic-project-id",
          environmentId: "synthetic-env-id",
        },
      });

      // Lands on NEW (no FK, co-resident with the batch); never on the control-plane DB
      // (where the create would have FK-violated).
      expect(await prisma17.waitpoint.findUnique({ where: { id: cuidWp } })).not.toBeNull();
      expect(await prisma14.waitpoint.findUnique({ where: { id: cuidWp } })).toBeNull();

      // And the batch-keyed lookup (batchSystem.unblockRunForBatch) still finds it cross-DB.
      const byBatch = await router.findWaitpoint({ where: { completedByBatchId: batchId } });
      expect(byBatch?.id).toBe(cuidWp);
    },
    120_000
  );
});

// Regression locks: the router must execute every routed op on the OWNING store's own
// client and route reads by friendlyId — never on the caller-forwarded client (callers
// pass the control-plane client, which is the wrong physical DB once a run lives in NEW).
describe("RoutingRunStore cross-DB client + friendlyId routing (regression)", () => {
  // A create routed to NEW must land on NEW even when the caller forwards the LEGACY
  // client as `tx` (the webapp passes its control-plane client there). If the router
  // forwarded it, the ksuid run would be written through the legacy connection.
  heteroPostgresTest(
    "createRun ignores a forwarded wrong-DB tx and lands the run on its owning store",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed17 = await seedEnvironment(prisma17, "txnew17");

      const newRunId = KSUID_27;
      await router.createRun(
        buildCreateRunInput({
          runId: newRunId,
          friendlyId: `run_${KSUID_27}`,
          taskIdentifier: "tx-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        }),
        // Forwarded LEGACY client — must be ignored in favour of the NEW store's own client.
        prisma14
      );

      expect(await prisma17.taskRun.findUnique({ where: { id: newRunId } })).not.toBeNull();
      expect(await prisma14.taskRun.findUnique({ where: { id: newRunId } })).toBeNull();
    }
  );

  // findRun keyed on friendlyId (the common presenter case) must route to the owning
  // store by residency — friendlyIds classify identically to internal ids.
  heteroPostgresTest(
    "findRun routes by friendlyId to the owning store",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "fid14");
      const seed17 = await seedEnvironment(prisma17, "fid17");

      const legacyFriendly = `run_${CUID_25}`;
      const newFriendly = `run_${KSUID_27}`;
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: CUID_25,
          friendlyId: legacyFriendly,
          taskIdentifier: "legacy-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );
      await newStore.createRun(
        buildCreateRunInput({
          runId: KSUID_27,
          friendlyId: newFriendly,
          taskIdentifier: "new-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        })
      );

      expect((await router.findRun({ friendlyId: legacyFriendly }))?.id).toBe(CUID_25);
      expect((await router.findRun({ friendlyId: newFriendly }))?.id).toBe(KSUID_27);
    }
  );

  // A routed write (updateMetadata) must mutate the run on its owning store, ignoring a
  // forwarded wrong-DB client — otherwise the write targets the legacy DB and silently
  // no-ops (count 0) against a NEW-resident run.
  heteroPostgresTest(
    "a routed write ignores a forwarded wrong-DB tx and hits the owning store",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed17 = await seedEnvironment(prisma17, "wr17");

      await newStore.createRun(
        buildCreateRunInput({
          runId: KSUID_27,
          friendlyId: `run_${KSUID_27}`,
          taskIdentifier: "write-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        })
      );

      const result = await router.updateMetadata(
        KSUID_27,
        { metadata: '{"x":1}', metadataVersion: { increment: 1 }, updatedAt: new Date() },
        {},
        // Forwarded LEGACY client — must be ignored.
        prisma14
      );

      expect(result.count).toBe(1);
      const row = await prisma17.taskRun.findUnique({
        where: { id: KSUID_27 },
        select: { metadata: true },
      });
      expect(row?.metadata).toBe('{"x":1}');
    }
  );
});

describe("RoutingRunStore.findRuns split-mode fan-out + drain", () => {
  // Internal-id convention (matches the file): `run_` + a 25-char body (cuid → LEGACY) or
  // a 27-char body (ksuid → NEW). The classifier strips `run_` then keys on body length.
  const legacyId = (suffix: string) => `run_${"c".repeat(25 - suffix.length)}${suffix}`;
  const newId = (suffix: string) => `run_${"k".repeat(27 - suffix.length)}${suffix}`;

  async function createRunOn(
    store: PostgresRunStore,
    seed: Awaited<ReturnType<typeof seedEnvironment>>,
    opts: {
      id: string;
      friendlyId: string;
      taskIdentifier?: string;
      createdAt?: Date;
      status?: TaskRunStatus;
      spanId?: string;
    }
  ) {
    const input = buildCreateRunInput({
      runId: opts.id,
      friendlyId: opts.friendlyId,
      taskIdentifier: opts.taskIdentifier ?? "my-task",
      organizationId: seed.organization.id,
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
    });
    if (opts.spanId) input.data.spanId = opts.spanId;
    if (opts.createdAt) input.data.createdAt = opts.createdAt;
    if (opts.status) {
      input.data.status = opts.status;
      input.snapshot.runStatus = opts.status;
    }
    await store.createRun(input);
  }

  // A bounded id set spanning both DBs must return BOTH residencies (the runs-list bug:
  // the old stub returned NEW only, dropping every legacy run).
  heteroPostgresTest("id-set fans out across NEW and LEGACY", async ({ prisma14, prisma17 }) => {
    const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
    const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
    const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
    const seed14 = await seedEnvironment(prisma14, "fo14");
    const seed17 = await seedEnvironment(prisma17, "fo17");
    const lId = legacyId("1");
    const nId = newId("1");
    await createRunOn(legacyStore, seed14, { id: lId, friendlyId: "run_fo_l1" });
    await createRunOn(newStore, seed17, { id: nId, friendlyId: "run_fo_n1" });

    const rows = (await router.findRuns({
      where: { id: { in: [lId, nId] } },
      select: { id: true },
    })) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([lId, nId].sort());
  });

  // Fan-out preserved after drain removal; onLegacyRead is no longer an accepted option.
  heteroPostgresTest(
    "fan-out spans NEW+LEGACY with no drain seam",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "nd14");
      const seed17 = await seedEnvironment(prisma17, "nd17");
      const lId = legacyId("x");
      const nId = newId("x");
      await createRunOn(legacyStore, seed14, { id: lId, friendlyId: "run_nd_l" });
      await createRunOn(newStore, seed17, { id: nId, friendlyId: "run_nd_n" });

      const rows = (await router.findRuns({
        where: { id: { in: [lId, nId] } },
        select: { id: true },
      })) as Array<{ id: string }>;
      expect(rows.map((r) => r.id).sort()).toEqual([lId, nId].sort());

      // @ts-expect-error onLegacyRead has been removed from RoutingRunStore options
      void new RoutingRunStore({ new: newStore, legacy: legacyStore, onLegacyRead: () => {} });
    }
  );

  // A run present on BOTH DBs (the copy->fence migration window) must be returned ONCE,
  // and the NEW copy wins.
  heteroPostgresTest(
    "id-set dedupes a run present on both DBs, preferring NEW",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "dd14");
      const seed17 = await seedEnvironment(prisma17, "dd17");
      const dupId = legacyId("9");
      await createRunOn(legacyStore, seed14, {
        id: dupId,
        friendlyId: "run_dd_l",
        taskIdentifier: "from-legacy",
      });
      await createRunOn(newStore, seed17, {
        id: dupId,
        friendlyId: "run_dd_n",
        taskIdentifier: "from-new",
      });

      const rows = (await router.findRuns({
        where: { id: { in: [dupId] } },
        select: { id: true, taskIdentifier: true },
      })) as Array<{ id: string; taskIdentifier: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.taskIdentifier).toBe("from-new");
    }
  );

  // An open predicate (no id set) unions both DBs and dedupes by id (NEW wins).
  heteroPostgresTest(
    "open predicate unions both DBs and dedupes by id",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "op14");
      const seed17 = await seedEnvironment(prisma17, "op17");
      const tId = "open-shared-task";
      const lOnly = legacyId("a");
      const nOnly = newId("a");
      const dup = legacyId("b");
      await createRunOn(legacyStore, seed14, {
        id: lOnly,
        friendlyId: "run_o_l",
        taskIdentifier: tId,
      });
      await createRunOn(newStore, seed17, {
        id: nOnly,
        friendlyId: "run_o_n",
        taskIdentifier: tId,
      });
      await createRunOn(legacyStore, seed14, {
        id: dup,
        friendlyId: "run_o_dl",
        taskIdentifier: tId,
      });
      await createRunOn(newStore, seed17, { id: dup, friendlyId: "run_o_dn", taskIdentifier: tId });

      const rows = (await router.findRuns({
        where: { taskIdentifier: tId },
        select: { id: true, friendlyId: true },
      })) as Array<{ id: string; friendlyId: string }>;
      expect(rows.map((r) => r.id).sort()).toEqual([lOnly, nOnly, dup].sort());
      expect(rows.find((r) => r.id === dup)?.friendlyId).toBe("run_o_dn");
    }
  );

  // orderBy + take are re-imposed across the MERGED set, not per-DB: the global top-2 by
  // createdAt desc interleaves the two databases.
  heteroPostgresTest(
    "re-imposes orderBy and take across the merged set",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "ot14");
      const seed17 = await seedEnvironment(prisma17, "ot17");
      const t = "order-take-task";
      const a = legacyId("p");
      const b = newId("p");
      const c = legacyId("q");
      const d = newId("q");
      await createRunOn(legacyStore, seed14, {
        id: a,
        friendlyId: "run_ot_a",
        taskIdentifier: t,
        createdAt: new Date("2024-03-04T00:00:00.000Z"),
      });
      await createRunOn(newStore, seed17, {
        id: b,
        friendlyId: "run_ot_b",
        taskIdentifier: t,
        createdAt: new Date("2024-03-03T00:00:00.000Z"),
      });
      await createRunOn(legacyStore, seed14, {
        id: c,
        friendlyId: "run_ot_c",
        taskIdentifier: t,
        createdAt: new Date("2024-03-02T00:00:00.000Z"),
      });
      await createRunOn(newStore, seed17, {
        id: d,
        friendlyId: "run_ot_d",
        taskIdentifier: t,
        createdAt: new Date("2024-03-01T00:00:00.000Z"),
      });

      const rows = (await router.findRuns({
        where: { taskIdentifier: t },
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { id: true },
      })) as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual([a, b]);
    }
  );

  // A bounded id set containing a LEGACY-resident cuid run is returned via the UNCONDITIONAL
  // LEGACY probe. Routing is pure id-shape (no isMigrated predicate), so a cuid id NEW misses
  // is always probed on LEGACY — where, with no migration, it always lives.
  heteroPostgresTest(
    "id-set returns a not-migrated LEGACY-resident cuid run via the unconditional probe (no isMigrated)",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "unc14");
      await seedEnvironment(prisma17, "unc17");
      const cuid = legacyId("u"); // 25-char body -> cuid -> LEGACY-resident
      await createRunOn(legacyStore, seed14, { id: cuid, friendlyId: "run_unc" });

      const rows = (await router.findRuns({
        where: { id: { in: [cuid] } },
        select: { id: true },
      })) as Array<{ id: string }>;
      // The cuid run lives only on LEGACY; without a probe-skip it MUST be returned.
      expect(rows.map((r) => r.id)).toEqual([cuid]);
    }
  );

  // An id-set combined with orderBy + take must page across the MERGED set, not per-store:
  // the global top-2 by createdAt desc interleaves both databases.
  heteroPostgresTest(
    "id-set with orderBy + take pages globally across both DBs",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "it14");
      const seed17 = await seedEnvironment(prisma17, "it17");
      const a = legacyId("r");
      const b = newId("r");
      const c = legacyId("s");
      const d = newId("s");
      await createRunOn(legacyStore, seed14, {
        id: a,
        friendlyId: "run_it_a",
        createdAt: new Date("2024-04-04T00:00:00.000Z"),
      });
      await createRunOn(newStore, seed17, {
        id: b,
        friendlyId: "run_it_b",
        createdAt: new Date("2024-04-03T00:00:00.000Z"),
      });
      await createRunOn(legacyStore, seed14, {
        id: c,
        friendlyId: "run_it_c",
        createdAt: new Date("2024-04-02T00:00:00.000Z"),
      });
      await createRunOn(newStore, seed17, {
        id: d,
        friendlyId: "run_it_d",
        createdAt: new Date("2024-04-01T00:00:00.000Z"),
      });

      const rows = (await router.findRuns({
        where: { id: { in: [a, b, c, d] } },
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { id: true },
      })) as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual([a, b]);
    }
  );

  // A findRun whose `where` is NOT residency-classifiable (e.g. by spanId — the span-detail
  // pane) must fan out and find a LEGACY-resident run, not default to NEW and miss it.
  heteroPostgresTest(
    "findRun by an unclassifiable where (spanId) finds a LEGACY-resident run",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "sp14");
      const seed17 = await seedEnvironment(prisma17, "sp17");

      const legacyRunId = legacyId("s");
      await createRunOn(legacyStore, seed14, {
        id: legacyRunId,
        friendlyId: "run_span_legacy",
        spanId: "span_on_legacy",
      });
      const newRunId = newId("s");
      await createRunOn(newStore, seed17, {
        id: newRunId,
        friendlyId: "run_span_new",
        spanId: "span_on_new",
      });

      const legacyHit = (await router.findRun(
        { spanId: "span_on_legacy" },
        { select: { id: true, spanId: true } }
      )) as { id: string } | null;
      expect(legacyHit?.id).toBe(legacyRunId);

      const newHit = (await router.findRun(
        { spanId: "span_on_new" },
        { select: { id: true, spanId: true } }
      )) as { id: string } | null;
      expect(newHit?.id).toBe(newRunId);
    }
  );

  // A waitpoint can live on NEW with a LEGACY-classified (cuid) id — e.g. a migrated run's
  // waitpoint. forWaitpointCompletion must resolve to the store that actually holds it, not
  // route by id-shape and miss it (which leaves the blocked run stuck forever).
  heteroPostgresTest(
    "forWaitpointCompletion resolves to the store holding the waitpoint, not its id-shape",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed17 = await seedEnvironment(prisma17, "wpc17");

      const cuidWaitpointId = `waitpoint_${"c".repeat(25)}`; // classifies LEGACY by id-shape
      await prisma17.waitpoint.create({
        data: {
          id: cuidWaitpointId,
          friendlyId: "waitpoint_wpc_x",
          type: "MANUAL",
          idempotencyKey: "wpc-key",
          userProvidedIdempotencyKey: false,
          projectId: seed17.project.id,
          environmentId: seed17.environment.id,
        },
      });

      const store = await router.forWaitpointCompletion(cuidWaitpointId, { routeKind: "MANUAL" });
      const found = await store.findWaitpoint({ where: { id: cuidWaitpointId } });
      expect(found?.id).toBe(cuidWaitpointId);
    }
  );

  // A waitpoint must be born on the same DB as its run (cuid → LEGACY, ksuid → NEW) so that
  // completion and the blocking edge — which already routes by run id — line up. A cuid
  // waitpoint landing on NEW is the regression that strands a non-opted org's wait forever.
  heteroPostgresTest(
    "createWaitpoint co-locates a waitpoint with its run by id-shape",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "wpco14");
      const seed17 = await seedEnvironment(prisma17, "wpco17");

      const cuidWp = `waitpoint_${CUID_25}`;
      await router.createWaitpoint({
        data: {
          id: cuidWp,
          friendlyId: "waitpoint_co_c",
          type: "MANUAL",
          idempotencyKey: "co-key-c",
          userProvidedIdempotencyKey: false,
          projectId: seed14.project.id,
          environmentId: seed14.environment.id,
        },
      });
      expect(await prisma14.waitpoint.findUnique({ where: { id: cuidWp } })).not.toBeNull();
      expect(await prisma17.waitpoint.findUnique({ where: { id: cuidWp } })).toBeNull();

      const ksuidWp = `waitpoint_${KSUID_27}`;
      await router.createWaitpoint({
        data: {
          id: ksuidWp,
          friendlyId: "waitpoint_co_k",
          type: "MANUAL",
          idempotencyKey: "co-key-k",
          userProvidedIdempotencyKey: false,
          projectId: seed17.project.id,
          environmentId: seed17.environment.id,
        },
      });
      expect(await prisma17.waitpoint.findUnique({ where: { id: ksuidWp } })).not.toBeNull();
      expect(await prisma14.waitpoint.findUnique({ where: { id: ksuidWp } })).toBeNull();
    }
  );
});

// Fan-out over the two DISTINCT generated schemas.
// prisma17 is RunOpsPrismaClient (subset schema, no control-plane tables).
describe("RoutingRunStore.findRuns cross-DB fan-out over distinct schemas", () => {
  const legacyId = (suffix: string) => `run_${"c".repeat(25 - suffix.length)}${suffix}`;
  const newId = (suffix: string) => `run_${"k".repeat(27 - suffix.length)}${suffix}`;

  heteroRunOpsPostgresTest(
    "id-set fans out across NEW (RunOpsPrismaClient) and LEGACY (PrismaClient) distinct schemas",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as any,
        readOnlyPrisma: prisma17 as any,
      });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "t10_14");

      const cuidId = legacyId("t10");
      await legacyStore.createRun(
        buildCreateRunInput({
          runId: cuidId,
          friendlyId: "run_t10_legacy",
          taskIdentifier: "t10-legacy-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      // NEW side has no control-plane tables and no associatedWaitpoint relation;
      // seed the TaskRun row directly with synthetic scalar ids.
      const ksuidId = newId("t10");
      await prisma17.taskRun.create({
        data: {
          id: ksuidId,
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_t10_new",
          runtimeEnvironmentId: "synthetic-env-id",
          environmentType: "DEVELOPMENT",
          organizationId: "synthetic-org-id",
          projectId: "synthetic-project-id",
          taskIdentifier: "t10-new-task",
          payload: '{"hello":"world"}',
          payloadType: "application/json",
          context: { foo: "bar" },
          traceContext: { trace: "ctx" },
          traceId: "trace_t10",
          spanId: "span_t10",
          runTags: [],
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
          createdAt: new Date("2024-06-01T00:00:00.000Z"),
        },
      });

      const rows = (await router.findRuns({
        where: { id: { in: [cuidId, ksuidId] } },
        select: { id: true },
      })) as Array<{ id: string }>;

      expect(rows.map((r) => r.id).sort()).toEqual([cuidId, ksuidId].sort());
    },
    120_000
  );
});

describe("RoutingRunStore write-path fan-outs", () => {
  const legacyId = (suffix: string) => `run_${"c".repeat(25 - suffix.length)}${suffix}`;
  const newId = (suffix: string) => `run_${"k".repeat(27 - suffix.length)}${suffix}`;

  async function createRunWithKey(
    store: PostgresRunStore,
    seed: Awaited<ReturnType<typeof seedEnvironment>>,
    opts: { id: string; friendlyId: string; idempotencyKey?: string }
  ) {
    const input = buildCreateRunInput({
      runId: opts.id,
      friendlyId: opts.friendlyId,
      taskIdentifier: "idem-task",
      organizationId: seed.organization.id,
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
    });
    if (opts.idempotencyKey) input.data.idempotencyKey = opts.idempotencyKey;
    await store.createRun(input);
  }

  // clearIdempotencyKey byFriendlyIds fans out to both DBs and sums counts.
  heteroPostgresTest(
    "clearIdempotencyKey byFriendlyIds fans out across NEW+LEGACY and sums count",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "ci_fo14");
      const seed17 = await seedEnvironment(prisma17, "ci_fo17");

      const lId = legacyId("ci1");
      const nId = newId("ci1");
      await createRunWithKey(legacyStore, seed14, {
        id: lId,
        friendlyId: "run_ci_legacy",
        idempotencyKey: "key-legacy",
      });
      await createRunWithKey(newStore, seed17, {
        id: nId,
        friendlyId: "run_ci_new",
        idempotencyKey: "key-new",
      });

      const result = await router.clearIdempotencyKey({
        byFriendlyIds: ["run_ci_legacy", "run_ci_new"],
      });

      expect(result.count).toBe(2);
      expect(
        (
          await prisma14.taskRun.findUnique({
            where: { id: lId },
            select: { idempotencyKey: true },
          })
        )?.idempotencyKey
      ).toBeNull();
      expect(
        (
          await prisma17.taskRun.findUnique({
            where: { id: nId },
            select: { idempotencyKey: true },
          })
        )?.idempotencyKey
      ).toBeNull();
    }
  );

  // clearIdempotencyKey byPredicate fans out to both DBs and sums counts.
  heteroPostgresTest(
    "clearIdempotencyKey byPredicate fans out across NEW+LEGACY and sums count",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "cp_fo14");
      const seed17 = await seedEnvironment(prisma17, "cp_fo17");

      const sharedKey = "shared-idem-key";
      const sharedTask = "shared-task";
      const lId = legacyId("cp1");
      const nId = newId("cp1");
      await createRunWithKey(legacyStore, seed14, {
        id: lId,
        friendlyId: "run_cp_legacy",
        idempotencyKey: sharedKey,
      });
      // Override taskIdentifier to match the predicate.
      const input = buildCreateRunInput({
        runId: nId,
        friendlyId: "run_cp_new",
        taskIdentifier: sharedTask,
        organizationId: seed17.organization.id,
        projectId: seed17.project.id,
        runtimeEnvironmentId: seed17.environment.id,
      });
      input.data.idempotencyKey = sharedKey;
      await newStore.createRun(input);

      // byPredicate matches on (idempotencyKey, taskIdentifier, runtimeEnvironmentId).
      // We target each DB's env separately to keep counts predictable (1 hit per DB).
      const [r14, r17] = await Promise.all([
        router.clearIdempotencyKey({
          byPredicate: {
            idempotencyKey: sharedKey,
            taskIdentifier: "idem-task",
            runtimeEnvironmentId: seed14.environment.id,
          },
        }),
        router.clearIdempotencyKey({
          byPredicate: {
            idempotencyKey: sharedKey,
            taskIdentifier: sharedTask,
            runtimeEnvironmentId: seed17.environment.id,
          },
        }),
      ]);

      // Each predicate call fans out to both stores; only the matching DB has a hit.
      expect(r14.count).toBe(1);
      expect(r17.count).toBe(1);
    }
  );

  // expireRunsBatch with mixed ksuid+cuid ids partitions across both DBs and sums.
  heteroPostgresTest(
    "expireRunsBatch with mixed ids partitions across NEW+LEGACY and sums count",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
      const seed14 = await seedEnvironment(prisma14, "exp_14");
      const seed17 = await seedEnvironment(prisma17, "exp_17");

      const lId = legacyId("ex1");
      const nId = newId("ex1");
      const input14 = buildCreateRunInput({
        runId: lId,
        friendlyId: "run_exp_l",
        taskIdentifier: "expire-task",
        organizationId: seed14.organization.id,
        projectId: seed14.project.id,
        runtimeEnvironmentId: seed14.environment.id,
      });
      await legacyStore.createRun(input14);
      const input17 = buildCreateRunInput({
        runId: nId,
        friendlyId: "run_exp_n",
        taskIdentifier: "expire-task",
        organizationId: seed17.organization.id,
        projectId: seed17.project.id,
        runtimeEnvironmentId: seed17.environment.id,
      });
      await newStore.createRun(input17);

      const expireData = {
        error: { type: "STRING_ERROR" as const, raw: "ttl expired" },
        now: new Date("2024-05-01T00:00:00.000Z"),
      };
      const count = await router.expireRunsBatch([lId, nId], expireData);

      expect(count).toBe(2);
      expect(
        (await prisma14.taskRun.findUnique({ where: { id: lId }, select: { status: true } }))
          ?.status
      ).toBe("EXPIRED");
      expect(
        (await prisma17.taskRun.findUnique({ where: { id: nId }, select: { status: true } }))
          ?.status
      ).toBe("EXPIRED");
    }
  );

  // all-ksuid batch goes only to NEW; LEGACY store is not called with an empty list.
  heteroPostgresTest(
    "expireRunsBatch all-ksuid batch skips LEGACY (no empty IN query)",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      let legacyCalled = false;
      const spyLegacy: RunStore = new Proxy(legacyStore, {
        get(target, prop) {
          if (prop === "expireRunsBatch") {
            return (...args: unknown[]) => {
              legacyCalled = true;
              return (target as any).expireRunsBatch(...args);
            };
          }
          return (target as any)[prop];
        },
      });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: spyLegacy });
      const seed17 = await seedEnvironment(prisma17, "ks_17");

      const nId = newId("kb1");
      await newStore.createRun(
        buildCreateRunInput({
          runId: nId,
          friendlyId: "run_ks_n",
          taskIdentifier: "ksuid-only-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        })
      );

      const expireData = {
        error: { type: "STRING_ERROR" as const, raw: "ttl" },
        now: new Date("2024-05-01T00:00:00.000Z"),
      };
      const count = await router.expireRunsBatch([nId], expireData);

      expect(count).toBe(1);
      expect(legacyCalled).toBe(false);
    }
  );
});

describe("RoutingRunStore.findTaskRunAttempt residency routing", () => {
  const legacyRunId = (suffix: string) => `run_${"c".repeat(25 - suffix.length)}${suffix}`;
  const newRunId = (suffix: string) => `run_${"k".repeat(27 - suffix.length)}${suffix}`;

  async function seedAttempt(
    prisma: PrismaClient,
    opts: {
      attemptId: string;
      friendlyId: string;
      runId: string;
      runtimeEnvironmentId: string;
      status?: string;
    }
  ) {
    await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "TaskRunAttempt" (id, number, "friendlyId", "taskRunId", "backgroundWorkerId", "backgroundWorkerTaskId", "runtimeEnvironmentId", "queueId", status, "createdAt", "updatedAt", "usageDurationMs", "outputType")
       VALUES ($1, 1, $2, $3, 'synthetic-worker', 'synthetic-worker-task', $4, 'synthetic-queue', $5::"TaskRunAttemptStatus", NOW(), NOW(), 0, 'application/json')`,
      opts.attemptId,
      opts.friendlyId,
      opts.runId,
      opts.runtimeEnvironmentId,
      opts.status ?? "COMPLETED"
    );
    await prisma.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
  }

  heteroPostgresTest(
    "a cuid (LEGACY) run's attempt resolves via findTaskRunAttempt (regression: was hardcoded NEW)",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "t9a_cuid14");
      const runId = legacyRunId("t9a1");
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_t9a_legacy",
          taskIdentifier: "t9a-legacy-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      const attemptId = "attempt_t9a_cuid1";
      await seedAttempt(prisma14, {
        attemptId,
        friendlyId: "attempt_t9a_c1",
        runId,
        runtimeEnvironmentId: seed14.environment.id,
        status: "COMPLETED",
      });

      const found = await router.findTaskRunAttempt({
        select: { id: true, taskRunId: true },
        where: { taskRunId: runId },
      });

      expect(found?.id).toBe(attemptId);
      expect(found?.taskRunId).toBe(runId);
      expect(await prisma17.taskRunAttempt.findUnique({ where: { id: attemptId } })).toBeNull();
    }
  );

  heteroPostgresTest(
    "a ksuid (NEW) run's attempt still resolves via findTaskRunAttempt",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed17 = await seedEnvironment(prisma17, "t9a_ksuid17");
      const runId = newRunId("t9a2");
      await newStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_t9a_new",
          taskIdentifier: "t9a-new-task",
          organizationId: seed17.organization.id,
          projectId: seed17.project.id,
          runtimeEnvironmentId: seed17.environment.id,
        })
      );

      const attemptId = "attempt_t9a_ksuid1";
      await seedAttempt(prisma17, {
        attemptId,
        friendlyId: "attempt_t9a_k1",
        runId,
        runtimeEnvironmentId: seed17.environment.id,
        status: "COMPLETED",
      });

      const found = await router.findTaskRunAttempt({
        select: { id: true, taskRunId: true },
        where: { taskRunId: runId },
      });

      expect(found?.id).toBe(attemptId);
      expect(found?.taskRunId).toBe(runId);
    }
  );

  // No taskRunId in where → fan out NEW-first then LEGACY.
  heteroPostgresTest(
    "no taskRunId where fans out NEW-first then LEGACY and finds a LEGACY attempt",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "t9a_fanout14");
      const runId = legacyRunId("t9a3");
      await legacyStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_t9a_fo",
          taskIdentifier: "t9a-fanout-task",
          organizationId: seed14.organization.id,
          projectId: seed14.project.id,
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      const attemptId = "attempt_t9a_fo1";
      const uniqueFriendlyId = `attempt_t9a_fo_${Date.now()}`;
      await seedAttempt(prisma14, {
        attemptId,
        friendlyId: uniqueFriendlyId,
        runId,
        runtimeEnvironmentId: seed14.environment.id,
        status: "COMPLETED",
      });

      const found = await router.findTaskRunAttempt({
        select: { id: true, friendlyId: true },
        where: { friendlyId: uniqueFriendlyId },
      });

      expect(found?.id).toBe(attemptId);
    }
  );
});

describe("findBatchTaskRunByFriendlyId probe", () => {
  function batchData(params: { id: string; friendlyId: string; runtimeEnvironmentId: string }) {
    return {
      id: params.id,
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      runCount: 1,
      runIds: [] as string[],
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      options: {},
      batchVersion: "runengine:v1",
    };
  }

  heteroPostgresTest(
    "a batch on LEGACY resolves via the NEW-first probe",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "t08_leg14");
      await legacyStore.createBatchTaskRun(
        batchData({
          id: "batch_t08_legacy",
          friendlyId: "batch_t08_leg",
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      const found = await router.findBatchTaskRunByFriendlyId(
        "batch_t08_leg",
        seed14.environment.id
      );
      expect(found?.id).toBe("batch_t08_legacy");
      expect(
        await prisma17.batchTaskRun.findUnique({ where: { id: "batch_t08_legacy" } })
      ).toBeNull();
    }
  );

  heteroPostgresTest("a batch on NEW resolves immediately", async ({ prisma14, prisma17 }) => {
    const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
    const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
    const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

    const seed17 = await seedEnvironment(prisma17, "t08_new17");
    await newStore.createBatchTaskRun(
      batchData({
        id: "batch_t08_new",
        friendlyId: "batch_t08_new",
        runtimeEnvironmentId: seed17.environment.id,
      })
    );

    const found = await router.findBatchTaskRunByFriendlyId("batch_t08_new", seed17.environment.id);
    expect(found?.id).toBe("batch_t08_new");
    expect(await prisma14.batchTaskRun.findUnique({ where: { id: "batch_t08_new" } })).toBeNull();
  });

  heteroPostgresTest(
    "env-scoping: wrong environmentId returns null",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "t08_es14");
      await legacyStore.createBatchTaskRun(
        batchData({
          id: "batch_t08_scope",
          friendlyId: "batch_t08_scope",
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      const found = await router.findBatchTaskRunByFriendlyId(
        "batch_t08_scope",
        "wrong-env-id-00000000000000000"
      );
      expect(found).toBeNull();
    }
  );

  heteroPostgresTest(
    "include:{ errors:true } returns seeded BatchTaskRunError through the probe",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed17 = await seedEnvironment(prisma17, "t08_inc17");
      const batchId = "batch_t08_inc";
      await newStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_t08_inc",
          runtimeEnvironmentId: seed17.environment.id,
        })
      );
      await prisma17.batchTaskRunError.create({
        data: {
          id: "bterr_t08_1",
          batchTaskRunId: batchId,
          index: 0,
          taskIdentifier: "my-task",
          error: "something went wrong",
        },
      });

      const found = (await router.findBatchTaskRunByFriendlyId(
        "batch_t08_inc",
        seed17.environment.id,
        { include: { errors: true } }
      )) as ({ errors: Array<{ id: string }> } & Record<string, unknown>) | null;

      expect(found).not.toBeNull();
      expect(found?.errors).toHaveLength(1);
      expect(found?.errors[0]?.id).toBe("bterr_t08_1");
    }
  );
});

// Batch residency: the four new accessors must route by batch id so a ksuid
// batch + its items live on NEW with its child runs, and fall back to fan-out where there
// is no classifiable id (idempotency probe; status-only updateMany).
describe("RoutingRunStore batch-residency accessors", () => {
  function batchData(params: {
    id: string;
    friendlyId: string;
    runtimeEnvironmentId: string;
    idempotencyKey?: string;
  }) {
    return {
      id: params.id,
      friendlyId: params.friendlyId,
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      runCount: 1,
      runIds: [] as string[],
      payload: "{}",
      payloadType: "application/json",
      options: {},
      batchVersion: "runengine:v1",
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    };
  }

  // The dedicated run-ops schema has scalarized env/project/org FKs, so a TaskRun can be
  // created with arbitrary scalar ids — no Organization/Project/RuntimeEnvironment seeding (those
  // models don't exist on the dedicated subset). Items' taskRunId FK to TaskRun is KEPT, so the run
  // must exist before the item.
  async function seedDedicatedRun(prisma: RunOpsPrismaClient, envId: string, runId: string) {
    await prisma.taskRun.create({
      data: {
        id: runId,
        engine: "V2",
        status: "PENDING",
        friendlyId: `run_${runId}`,
        runtimeEnvironmentId: envId,
        environmentType: "DEVELOPMENT",
        organizationId: "org_dedicated",
        projectId: "proj_dedicated",
        taskIdentifier: "batch-task",
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: `t_${runId}`,
        spanId: `s_${runId}`,
        queue: "task/batch-task",
        isTest: false,
        taskEventStore: "taskEvent",
        depth: 0,
      },
    });
  }

  const ENV_NEW = "env_dedicated_new";

  // findBatchTaskRunByIdempotencyKey: no classifiable id ⇒ NEW-first probe finds a batch on either DB.
  heteroRunOpsPostgresTest(
    "findBatchTaskRunByIdempotencyKey probes NEW then LEGACY",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "optA_idem14");

      // ksuid batch with an idempotency key on NEW (dedicated, scalar env id)
      await newStore.createBatchTaskRun(
        batchData({
          id: `${KSUID_27.slice(0, -2)}i1`,
          friendlyId: "batch_idem_new",
          runtimeEnvironmentId: ENV_NEW,
          idempotencyKey: "key-new",
        })
      );
      // cuid batch with an idempotency key on LEGACY (full schema, real env)
      await legacyStore.createBatchTaskRun(
        batchData({
          id: `${CUID_25.slice(0, -2)}i1`,
          friendlyId: "batch_idem_legacy",
          runtimeEnvironmentId: seed14.environment.id,
          idempotencyKey: "key-legacy",
        })
      );

      expect((await router.findBatchTaskRunByIdempotencyKey(ENV_NEW, "key-new"))?.friendlyId).toBe(
        "batch_idem_new"
      );
      expect(
        (await router.findBatchTaskRunByIdempotencyKey(seed14.environment.id, "key-legacy"))
          ?.friendlyId
      ).toBe("batch_idem_legacy");
      // miss
      expect(await router.findBatchTaskRunByIdempotencyKey(ENV_NEW, "absent")).toBeNull();
    }
  );

  // updateManyBatchTaskRun: routes by where.id (ksuid→NEW, cuid→LEGACY); fans out + sums when unrouted.
  heteroRunOpsPostgresTest(
    "updateManyBatchTaskRun routes by where.id and fans out otherwise",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const seed14 = await seedEnvironment(prisma14, "optA_um14");

      const ksuidBatchId = `${KSUID_27.slice(0, -2)}m1`;
      const cuidBatchId = `${CUID_25.slice(0, -2)}m1`;
      await newStore.createBatchTaskRun(
        batchData({ id: ksuidBatchId, friendlyId: "batch_um_new", runtimeEnvironmentId: ENV_NEW })
      );
      await legacyStore.createBatchTaskRun(
        batchData({
          id: cuidBatchId,
          friendlyId: "batch_um_legacy",
          runtimeEnvironmentId: seed14.environment.id,
        })
      );

      // where.id ksuid → NEW only
      const upNew = await router.updateManyBatchTaskRun({
        where: { id: ksuidBatchId },
        data: { status: "COMPLETED" },
      });
      expect(upNew.count).toBe(1);
      expect(
        (await prisma17.batchTaskRun.findUnique({ where: { id: ksuidBatchId } }))?.status
      ).toBe("COMPLETED");

      // where.id cuid → LEGACY only
      const upLegacy = await router.updateManyBatchTaskRun({
        where: { id: cuidBatchId },
        data: { status: "COMPLETED" },
      });
      expect(upLegacy.count).toBe(1);
      expect((await prisma14.batchTaskRun.findUnique({ where: { id: cuidBatchId } }))?.status).toBe(
        "COMPLETED"
      );

      // status-only where (no id): fans out to BOTH and sums (both already COMPLETED)
      const upBoth = await router.updateManyBatchTaskRun({
        where: { status: "COMPLETED" },
        data: { status: "ABORTED" },
      });
      expect(upBoth.count).toBe(2);
    }
  );

  // countBatchTaskRunItems: routes by batchTaskRunId residency (items co-reside with the batch).
  heteroRunOpsPostgresTest(
    "countBatchTaskRunItems routes by batchTaskRunId residency",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const ksuidBatchId = `${KSUID_27.slice(0, -2)}c1`;
      await newStore.createBatchTaskRun(
        batchData({ id: ksuidBatchId, friendlyId: "batch_cnt_new", runtimeEnvironmentId: ENV_NEW })
      );

      const runA = `${KSUID_27.slice(0, -3)}cra`;
      const runB = `${KSUID_27.slice(0, -3)}crb`;
      await seedDedicatedRun(prisma17, ENV_NEW, runA);
      await seedDedicatedRun(prisma17, ENV_NEW, runB);
      await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: ksuidBatchId, taskRunId: runA, status: "COMPLETED" },
      });
      await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: ksuidBatchId, taskRunId: runB, status: "PENDING" },
      });

      expect(await router.countBatchTaskRunItems({ batchTaskRunId: ksuidBatchId })).toBe(2);
      expect(
        await router.countBatchTaskRunItems({ batchTaskRunId: ksuidBatchId, status: "COMPLETED" })
      ).toBe(1);
    }
  );

  // updateManyBatchTaskRunItems: routes by where.batchTaskRunId so items move with their batch.
  heteroRunOpsPostgresTest(
    "updateManyBatchTaskRunItems routes by where.batchTaskRunId",
    async ({ prisma14, prisma17 }) => {
      const legacyStore = new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14 });
      const newStore = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const ksuidBatchId = `${KSUID_27.slice(0, -2)}u1`;
      await newStore.createBatchTaskRun(
        batchData({ id: ksuidBatchId, friendlyId: "batch_ui_new", runtimeEnvironmentId: ENV_NEW })
      );

      const runX = `${KSUID_27.slice(0, -3)}uix`;
      await seedDedicatedRun(prisma17, ENV_NEW, runX);
      await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: ksuidBatchId, taskRunId: runX, status: "PENDING" },
      });

      const res = await router.updateManyBatchTaskRunItems({
        where: { batchTaskRunId: ksuidBatchId, taskRunId: runX },
        data: { status: "COMPLETED" },
      });
      expect(res.count).toBe(1);
      const item = await prisma17.batchTaskRunItem.findFirst({
        where: { batchTaskRunId: ksuidBatchId, taskRunId: runX },
      });
      expect(item?.status).toBe("COMPLETED");
    }
  );

  // Single-DB passthrough: both stores are the same; all four accessors collapse to it.
  heteroRunOpsPostgresTest(
    "single-DB passthrough for the batch-residency accessors",
    async ({ prisma17 }) => {
      const store = new PostgresRunStore({ prisma: prisma17, readOnlyPrisma: prisma17 });
      const router = new RoutingRunStore({ new: store, legacy: store });

      const batchId = `${KSUID_27.slice(0, -2)}s1`;
      await router.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId: "batch_single",
          runtimeEnvironmentId: ENV_NEW,
          idempotencyKey: "single-key",
        })
      );

      expect((await router.findBatchTaskRunByIdempotencyKey(ENV_NEW, "single-key"))?.id).toBe(
        batchId
      );

      const runId = `${KSUID_27.slice(0, -3)}srn`;
      await seedDedicatedRun(prisma17, ENV_NEW, runId);
      await prisma17.batchTaskRunItem.create({
        data: { batchTaskRunId: batchId, taskRunId: runId, status: "PENDING" },
      });
      expect(await router.countBatchTaskRunItems({ batchTaskRunId: batchId })).toBe(1);
      expect(
        (
          await router.updateManyBatchTaskRunItems({
            where: { batchTaskRunId: batchId },
            data: { status: "COMPLETED" },
          })
        ).count
      ).toBe(1);
      expect(
        (
          await router.updateManyBatchTaskRun({
            where: { id: batchId },
            data: { status: "COMPLETED" },
          })
        ).count
      ).toBe(1);
    }
  );
});

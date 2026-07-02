// Store-level regression suite for the run-ops split.
//
// These tests EMPIRICALLY PROVE the critical/high store-level correctness issues against the REAL
// dedicated subset schema (`heteroRunOpsPostgresTest.prisma17` is a real `RunOpsPrismaClient` over
// the @internal/run-ops-database SUBSET schema) and the full legacy schema on a SEPARATE physical
// PG container (`prisma14`). An earlier harness masked every one of these by backing the "#new"
// store with the FULL legacy schema and globally minting ksuid, so the split never ran against the
// dedicated schema.
//
// Each case either asserts the fixed behavior directly or, for a still-open item, wraps the broken
// behavior so the suite documents it. They are runnable (not skipped) so the behavior is
// demonstrated end-to-end against two physical DBs.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH (runOpsResidency.ts): 25 chars → cuid → LEGACY,
// 27 chars → ksuid → NEW. A `run_`-prefixed friendly id strips the first underscore before length.
const CUID_25 = "c".repeat(25); // → LEGACY (#legacy / control-plane DB, full schema)
const KSUID_27 = "k".repeat(27); // → NEW (#new / dedicated run-ops DB, subset schema)

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (the run-ops
// rows carry FK-free scalar ids), so we mint synthetic owning ids. On legacy we seed the real rows
// the kept FKs require.
async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  suffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${suffix}` },
      project: { id: `proj_${suffix}` },
      environment: { id: `env_${suffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
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
      environmentType: "DEVELOPMENT",
      organizationId: params.organizationId,
      projectId: params.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
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
      environmentId: params.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: params.projectId,
      organizationId: params.organizationId,
    },
  };
}

function makeDedicatedStore(prisma17: RunOpsPrismaClient) {
  return new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
}

function makeLegacyStore(prisma14: PrismaClient) {
  return new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
}

// The REAL production split topology: #new = dedicated subset on prisma17, #legacy = full schema on
// prisma14. Two physically-distinct DBs, dedicated schema on #new — exactly what a single-schema
// harness never wires.
function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = makeLegacyStore(prisma14);
  const newStore = makeDedicatedStore(prisma17);
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    legacyStore,
    newStore,
  };
}

describe("run-ops split — store-level behavior against the REAL dedicated schema", () => {
  // ===========================================================================================
  // continueRunIfUnblocked dedicated-schema relation-select validation throw.
  // `continueRunIfUnblocked` reads edges with `select:{ waitpoint:{...} }`
  // (waitpointSystem.ts); the dedicated `TaskRunWaitpoint` model has NO `waitpoint`
  // relation (only a `waitpointId` scalar), and `PostgresRunStore.findManyTaskRunWaitpoints`
  // must strip/hydrate rather than pass the args straight through. Against the real run-ops subset
  // client an un-stripped select is a Prisma validation error → every waitpoint-blocked run hangs.
  // ===========================================================================================

  // The EXACT caller select from continueRunIfUnblocked step 1 no longer throws on the dedicated
  // client. With no edges seeded it returns []; the dedicated strip/hydrate branch
  // (PostgresRunStore.findManyTaskRunWaitpoints) handles the missing `waitpoint` relation.
  heteroRunOpsPostgresTest(
    "findManyTaskRunWaitpoints with the continueRunIfUnblocked select does NOT throw on the DEDICATED client",
    async ({ prisma17 }) => {
      const store = makeDedicatedStore(prisma17);

      const rows = await store.findManyTaskRunWaitpoints({
        where: { taskRunId: `run_${KSUID_27}` },
        select: {
          id: true,
          batchId: true,
          batchIndex: true,
          waitpoint: {
            select: { id: true, status: true, type: true, completedAfter: true },
          },
        },
      });
      expect(rows).toEqual([]);
    }
  );

  // A co-resident block edge on the dedicated client hydrates its `waitpoint`
  // relation from the scalar `waitpointId`, returning the requested fields (no Prisma throw).
  heteroRunOpsPostgresTest(
    "the dedicated waitpoint relation-select hydrates a co-resident waitpoint",
    async ({ prisma17 }) => {
      const store = makeDedicatedStore(prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "gap4hyd_new");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${KSUID_27}`;
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap4hyd",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });
      await prisma17.taskRunWaitpoint.create({
        data: { taskRunId: runId, waitpointId, projectId: env.project.id },
      });

      const rows = await store.findManyTaskRunWaitpoints({
        where: { taskRunId: runId },
        select: {
          id: true,
          waitpoint: { select: { id: true, status: true } },
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].waitpoint).toEqual({ id: waitpointId, status: "PENDING" });
    }
  );

  // Control: the LEGACY full schema HAS the `waitpoint` relation, so the same select must NOT throw.
  // This proves the throw is specific to the dedicated subset schema, not the query shape.
  heteroRunOpsPostgresTest(
    "control: the SAME select does NOT throw on the LEGACY full schema",
    async ({ prisma14 }) => {
      const store = makeLegacyStore(prisma14);

      const rows = await store.findManyTaskRunWaitpoints({
        where: { taskRunId: `run_${KSUID_27}` },
        select: {
          id: true,
          waitpoint: { select: { id: true, status: true } },
        },
      });
      expect(rows).toEqual([]);
    }
  );

  // The full router path (continueRunIfUnblocked fans to BOTH stores via
  // RoutingRunStore.findManyTaskRunWaitpoints) no longer throws — the #new (dedicated) leg strips
  // the relation and the router re-resolves `waitpoint` cross-DB. Empty result with no edges seeded.
  heteroRunOpsPostgresTest(
    "RoutingRunStore.findManyTaskRunWaitpoints does NOT throw even though the #new leg is dedicated",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);

      const rows = await router.findManyTaskRunWaitpoints({
        where: { taskRunId: `run_${KSUID_27}` },
        select: {
          id: true,
          waitpoint: { select: { id: true, status: true, type: true, completedAfter: true } },
        },
      });
      expect(rows).toEqual([]);
    }
  );

  // ===========================================================================================
  // Cross-DB waitpoint hydration through the router.
  // A ksuid run (on #new) blocked by a waitpoint that lives on the OTHER DB (#legacy). The block
  // edge co-resides with the run on #new; the token is on #legacy. A single store hydrates the
  // edge's `waitpoint` from its own client → null → the run hangs / loses output. The
  // router must re-resolve the token across BOTH DBs.
  // ===========================================================================================

  // Co-resident control (the ksuid happy path): a ksuid run blocked by a ksuid waitpoint,
  // both on #new, hydrates through the router with the real status/output.
  heteroRunOpsPostgresTest(
    "cross-DB: a ksuid run blocked by a CO-RESIDENT ksuid waitpoint hydrates the real status via the router",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "cores_new");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${KSUID_27}`;
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_cores",
          type: "MANUAL",
          status: "COMPLETED",
          output: '{"resumed":"co-resident"}',
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });
      await prisma17.taskRunWaitpoint.create({
        data: { taskRunId: runId, waitpointId, projectId: env.project.id },
      });

      const rows = await router.findManyTaskRunWaitpoints({
        where: { taskRunId: runId },
        select: {
          id: true,
          waitpoint: { select: { id: true, status: true, output: true } },
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].waitpoint).toEqual({
        id: waitpointId,
        status: "COMPLETED",
        output: '{"resumed":"co-resident"}',
      });
    }
  );

  // The cross-DB topology. The block edge is on #new (co-resident with the
  // ksuid run), the completing token is on #legacy. The router resolves the token across both DBs
  // and returns its REAL status and OUTPUT (the wrong-result guard) — a single store would
  // hydrate null here and strand the run.
  heteroRunOpsPostgresTest(
    "cross-DB: a ksuid run completed by a waitpoint on the OTHER DB hydrates the real status + output via the router",
    async ({ prisma14, prisma17 }) => {
      const { router, newStore } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "xdb_new");
      const legEnv = await seedEnvironment(prisma14, "legacy", "xdb_leg");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${CUID_25}`; // cuid → lives on #legacy

      // The completing token lives on #legacy (cuid MANUAL token blocking a ksuid run).
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_xdb",
          type: "MANUAL",
          status: "COMPLETED",
          output: '{"resumed":"cross-db"}',
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });
      // The block edge co-resides with the ksuid RUN on #new.
      await prisma17.taskRunWaitpoint.create({
        data: { taskRunId: runId, waitpointId, projectId: newEnv.project.id },
      });

      // Single-store guard: the #new store alone hydrates the edge's waitpoint to null (the token is
      // on #legacy) — proving the bug the router fixes.
      const singleStoreRows = await newStore.findManyTaskRunWaitpoints({
        where: { taskRunId: runId },
        select: { id: true, waitpoint: { select: { id: true, status: true, output: true } } },
      });
      expect(singleStoreRows[0].waitpoint).toBeNull();

      // Router path: resolves the cross-DB token and returns the real status + output.
      const rows = await router.findManyTaskRunWaitpoints({
        where: { taskRunId: runId },
        select: {
          id: true,
          waitpoint: { select: { id: true, status: true, output: true } },
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].waitpoint).toEqual({
        id: waitpointId,
        status: "COMPLETED",
        output: '{"resumed":"cross-db"}',
      });
    }
  );

  // Hard-error contract: a blocking edge whose waitpoint exists on NEITHER DB must throw, never
  // resolve to null (which would let continueRunIfUnblocked treat it as not-COMPLETED forever, or
  // silently complete). The router raises rather than strand the run on a phantom blocker.
  heteroRunOpsPostgresTest(
    "cross-DB: a block edge whose waitpoint is on NEITHER DB throws (no silent null)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "phantom_new");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${"p".repeat(27)}`; // ksuid-shaped, but never created anywhere

      await prisma17.taskRunWaitpoint.create({
        data: { taskRunId: runId, waitpointId, projectId: newEnv.project.id },
      });

      await expect(
        router.findManyTaskRunWaitpoints({
          where: { taskRunId: runId },
          select: { id: true, waitpoint: { select: { id: true, status: true } } },
        })
      ).rejects.toThrow(/not found on either run-ops DB/i);
    }
  );

  // ===========================================================================================
  // checkpoint→snapshot residency FK break.
  // If `createTaskRunCheckpoint` were hardcoded to `#new` while the referencing execution snapshot
  // routes by run id, a cuid run's snapshot would land on `#legacy` carrying a `checkpointId` that
  // only exists on `#new` → TaskRunExecutionSnapshot_checkpointId_fkey violated; the run cannot
  // suspend/checkpoint. Live V2 path (checkpointSystem.ts).
  // ===========================================================================================

  // createTaskRunCheckpoint routes by the OWNING run id, so a cuid run's
  // checkpoint co-resides on #legacy with its snapshot. The referencing snapshot insert (routed to
  // #legacy by the cuid run id) satisfies the checkpointId FK on the same DB — no throw.
  heteroRunOpsPostgresTest(
    "a cuid-run snapshot referencing its checkpoint satisfies the checkpointId FK on #legacy",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);

      // A cuid (LEGACY-resident) run — the in-flight cohort that keeps executing after split-on.
      const env = await seedEnvironment(prisma14, "legacy", "gap2_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap2_legacy",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      // checkpointSystem path: create the checkpoint routed by the OWNING (cuid) run id → #legacy.
      const checkpoint = await router.createTaskRunCheckpoint(
        {
          data: {
            friendlyId: `checkpoint_${CUID_25}`,
            type: "DOCKER",
            location: "s3://bucket/cuid-run-checkpoint",
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          },
        },
        runId
      );

      // The referencing snapshot routes by the cuid run id → #legacy. Its checkpointId now resolves
      // on the same DB (the checkpoint co-resides), so the insert succeeds.
      const snapshot = await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: {
          executionStatus: "SUSPENDED",
          description: "Run suspended after checkpoint",
        },
        checkpointId: checkpoint.id,
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });
      expect(snapshot.checkpointId).toBe(checkpoint.id);
    }
  );

  // Residency proof: the checkpoint, routed by its cuid owning run id,
  // co-resides on #legacy (prisma14) and is ABSENT from #new (prisma17).
  heteroRunOpsPostgresTest(
    "createTaskRunCheckpoint co-locates the checkpoint with its owning cuid run on #legacy",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "gap2res_leg");
      const runId = `run_${CUID_25}`;

      const checkpoint = await router.createTaskRunCheckpoint(
        {
          data: {
            friendlyId: `checkpoint_res_${CUID_25}`,
            type: "DOCKER",
            location: "s3://bucket/cp",
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          },
        },
        runId
      );

      // Present on #legacy (full schema / prisma14) — where the cuid run's snapshot lives.
      const onLegacy = await prisma14.taskRunCheckpoint.findUnique({
        where: { id: checkpoint.id },
      });
      expect(onLegacy).not.toBeNull();
      // Absent from #new (dedicated / prisma17).
      const onNew = await prisma17.taskRunCheckpoint.findUnique({ where: { id: checkpoint.id } });
      expect(onNew).toBeNull();
    }
  );

  // Control: a ksuid run's checkpoint, routed by its owning run id, co-resides on #new.
  heteroRunOpsPostgresTest(
    "control: a ksuid run's checkpoint co-resides on #new with its snapshot",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "gap2k_new");
      const runId = `run_${KSUID_27}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap2k_new",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      const checkpoint = await router.createTaskRunCheckpoint(
        {
          data: {
            friendlyId: `checkpoint_${KSUID_27}`,
            type: "DOCKER",
            location: "s3://bucket/ksuid-run-checkpoint",
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          },
        },
        runId
      );

      const onNew = await prisma17.taskRunCheckpoint.findUnique({ where: { id: checkpoint.id } });
      expect(onNew).not.toBeNull();

      const snapshot = await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "SUSPENDED", description: "ksuid suspended" },
        checkpointId: checkpoint.id,
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });
      expect(snapshot.checkpointId).toBe(checkpoint.id);
    }
  );

  // ===========================================================================================
  // Snapshot reads must route by run id, not hardcode `#new`.
  // If `findExecutionSnapshot` / `findManyExecutionSnapshots` were hardcoded to `#new`, then for a
  // cuid run (snapshots on #legacy, because createExecutionSnapshot routes by run id) these reads
  // would miss it → null / empty. The getExecutionSnapshotsSince warm-restart path would then throw
  // ExecutionSnapshotNotFoundError.
  // ===========================================================================================

  // findExecutionSnapshot routes by the OWNING run id, so a cuid run's
  // #legacy snapshot is found through the router (the warm-restart `getExecutionSnapshotsSince` step 1
  // shape `{ id, runId }`).
  heteroRunOpsPostgresTest(
    "findExecutionSnapshot FINDS a cuid run's #legacy snapshot via the router",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore } = makeSplitRouter(prisma14, prisma17);

      const env = await seedEnvironment(prisma14, "legacy", "gap5_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap5_legacy",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      // Snapshot routes by the cuid run id → physically created on #legacy.
      const created = await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "cuid run executing" },
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });

      // Sanity: the snapshot really is on #legacy (a direct legacy-store read finds it).
      const onLegacy = await legacyStore.findExecutionSnapshot({
        where: { id: created.id, runId },
      });
      expect(onLegacy).not.toBeNull();

      // The router routes by `where.runId` → #legacy → the cuid run's snapshot is found.
      const viaRouter = await router.findExecutionSnapshot({ where: { id: created.id, runId } });
      expect(viaRouter).not.toBeNull();
      expect(viaRouter!.id).toBe(created.id);
    }
  );

  // findManyExecutionSnapshots routes by `where.runId`, so
  // the warm-restart step-2 shape sees a cuid run's #legacy snapshots instead of an empty #new read.
  heteroRunOpsPostgresTest(
    "findManyExecutionSnapshots SEES a cuid run's #legacy snapshots via the router",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);

      const env = await seedEnvironment(prisma14, "legacy", "gap5b_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap5b_legacy",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "cuid run executing 2" },
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });

      // getExecutionSnapshotsSince step 2 shape: findMany by runId on the router → routes to #legacy.
      const many = await router.findManyExecutionSnapshots({
        where: { runId, isValid: true },
      });
      expect(many.length).toBeGreaterThanOrEqual(1);
    }
  );

  // A by-snapshot-id-only read (no runId — snapshot ids are cuids, not classifiable) fans out
  // NEW→LEGACY, so a cuid run's #legacy snapshot is still found.
  heteroRunOpsPostgresTest(
    "findExecutionSnapshot with no runId fans out NEW→LEGACY",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);

      const env = await seedEnvironment(prisma14, "legacy", "gap5d_leg");
      const runId = `run_${CUID_25}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap5d_legacy",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      const created = await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "cuid run executing 3" },
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });

      // No runId in the where — the router must probe both DBs to find the #legacy snapshot.
      const viaRouter = await router.findExecutionSnapshot({ where: { id: created.id } });
      expect(viaRouter).not.toBeNull();
      expect(viaRouter!.id).toBe(created.id);
    }
  );

  // Control: a KSUID run (on #new / dedicated) IS visible through the router — proving the read gap
  // is residency-specific (only the cuid/#legacy cohort would be dropped), not a blanket failure.
  heteroRunOpsPostgresTest(
    "control: a ksuid run's #new snapshot IS found through the router",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);

      const env = await seedEnvironment(prisma17, "dedicated", "gap5c_new");
      const runId = `run_${KSUID_27}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap5c_new",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      const created = await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "ksuid run executing" },
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });

      const viaRouter = await router.findExecutionSnapshot({ where: { id: created.id, runId } });
      expect(viaRouter).not.toBeNull();
      expect(viaRouter!.id).toBe(created.id);
    }
  );

  // ===========================================================================================
  // blockWaitpoint raw-CTE wrong-DB no-block.
  // `RunEngine.trigger` passes `tx: prisma` (control-plane) into
  // `blockRunWithWaitpoint(Lockless)`, forcing the `if (tx)` raw
  // `$queryRaw` CTE branch. The CTE inserts into
  // `TaskRunWaitpoint`/`_WaitpointRunConnections` and joins `FROM "Waitpoint" w WHERE w.id IN (...)`
  // on the `tx`'s DB. When the waitpoint lives on the OTHER physical DB, the join returns 0 rows →
  // no edge written → isRunBlocked=false → the parent is silently never suspended.
  //
  // SCOPING: the behavior lives in WaitpointSystem.blockRunWithWaitpoint, which requires a full
  // SystemResources context (RunQueue, EventBus, RunLocker/Redis, controlPlaneResolver, worker,
  // pendingVersionRunIdLookup) plus `runLock.lock` and getLatestExecutionSnapshot.
  // That is not constructible as a run-store unit test; a faithful end-to-end repro needs the full
  // RunEngine.trigger wiring with two physical DBs. What IS tractable here is
  // the CORE MECHANISM: the exact raw CTE, run against a `tx` whose DB does NOT hold the waitpoint,
  // inserts ZERO block edges. We reproduce that precisely below; the engine-level "parent ends NOT
  // suspended" assertion is left to a RunEngine integration test.
  // ===========================================================================================

  // Proof of the mechanism: the verbatim block-edge CTE
  // run on `tx = prisma14` (the control-plane / #legacy DB) inserts NOTHING when the waitpoint was
  // created on prisma17 (#new), because `FROM "Waitpoint" w WHERE w.id IN (...)` finds 0 rows on
  // prisma14. Asserts the wrong-DB behavior (0 edges) directly.
  heteroRunOpsPostgresTest(
    "mechanism: the block-edge CTE writes ZERO edges when the waitpoint is on the other DB",
    async ({ prisma14, prisma17 }) => {
      // A ksuid parent run + its associated waitpoint live on #new (prisma17 / dedicated).
      const newEnv = await seedEnvironment(prisma17, "dedicated", "gap3_new");
      const parentRunId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${KSUID_27}`;
      await prisma17.taskRun.create({
        data: {
          id: parentRunId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_gap3_parent",
          runtimeEnvironmentId: newEnv.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${parentRunId}`,
          spanId: `span_${parentRunId}`,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap3",
          type: "RUN",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: newEnv.project.id,
          environmentId: newEnv.environment.id,
        },
      });

      // The forced-tx branch: RunEngine.trigger passes the control-plane client (= the #legacy DB
      // here) as `tx`. Run the VERBATIM block-edge CTE on prisma14 (#legacy).
      await prisma14.$queryRaw`
        WITH inserted AS (
          INSERT INTO "TaskRunWaitpoint" ("id", "taskRunId", "waitpointId", "projectId", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), ${parentRunId}, w.id, ${newEnv.project.id}, NOW(), NOW()
          FROM "Waitpoint" w
          WHERE w.id IN (${waitpointId})
          ON CONFLICT DO NOTHING
          RETURNING "waitpointId"
        )
        SELECT COUNT(*) FROM inserted`;

      // The waitpoint is on #new, so the join on #legacy matched nothing → NO edge on EITHER DB.
      const edgesOnLegacy = await prisma14.taskRunWaitpoint.count({
        where: { taskRunId: parentRunId },
      });
      const edgesOnNew = await prisma17.taskRunWaitpoint.count({
        where: { taskRunId: parentRunId },
      });
      expect(edgesOnLegacy).toBe(0); // the CTE inserted nothing (Waitpoint join empty)
      expect(edgesOnNew).toBe(0); // and it never touched the #new DB where the waitpoint lives

      // Therefore countPendingWaitpoints sees no PENDING blocker for the run → the engine would
      // treat isRunBlocked=false and NOT suspend the parent. (countPendingWaitpoints on #new finds
      // the PENDING waitpoint by id, but with NO edge bound to the run the engine never asks.)
    }
  );

  // Control: the SAME CTE on the DB that DOES hold the waitpoint writes the edge correctly —
  // proving the failure is purely the wrong-DB join, not a malformed CTE.
  heteroRunOpsPostgresTest(
    "control: the block-edge CTE writes the edge when the waitpoint is co-resident",
    async ({ prisma14 }) => {
      const env = await seedEnvironment(prisma14, "legacy", "gap3ctl_leg");
      const parentRunId = `run_${CUID_25}`;
      const waitpointId = `waitpoint_${CUID_25}`;
      await prisma14.taskRun.create({
        data: {
          id: parentRunId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_gap3ctl_parent",
          runtimeEnvironmentId: env.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: env.organization.id,
          projectId: env.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${parentRunId}`,
          spanId: `span_${parentRunId}`,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap3ctl",
          type: "RUN",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      await prisma14.$queryRaw`
        WITH inserted AS (
          INSERT INTO "TaskRunWaitpoint" ("id", "taskRunId", "waitpointId", "projectId", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), ${parentRunId}, w.id, ${env.project.id}, NOW(), NOW()
          FROM "Waitpoint" w
          WHERE w.id IN (${waitpointId})
          ON CONFLICT DO NOTHING
          RETURNING "waitpointId"
        )
        SELECT COUNT(*) FROM inserted`;

      const edges = await prisma14.taskRunWaitpoint.count({ where: { taskRunId: parentRunId } });
      expect(edges).toBe(1); // co-resident → the edge is written, the parent would suspend
    }
  );

  // ===========================================================================================
  // Lazy RUN-waitpoint residency split.
  // `getOrCreateRunWaitpoint` creates the lazy RUN waitpoint via `createWaitpoint`
  // carrying `completedByTaskRunId: runId`. Production never mints ksuid waitpoint ids, so routing by
  // the waitpoint's OWN id-shape would land it on #legacy while a ksuid run is on #new → run-completion
  // hydrate (associatedWaitpoint by completedByTaskRunId on the run's DB) misses it → parent hangs.
  // Fix: route the create by the OWNING run id (completedByTaskRunId) so it co-resides with the run.
  // ===========================================================================================

  // A ksuid run's lazy RUN-waitpoint with a CUID-shaped waitpoint id (production-like: ksuid
  // waitpoint minting is off) co-resides on #new with the run, NOT on #legacy by its own id-shape.
  heteroRunOpsPostgresTest(
    "a ksuid run's lazy RUN-waitpoint co-resides on #new (routed by completedByTaskRunId)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "gap6_new");
      const runId = `run_${KSUID_27}`; // ksuid run → #new
      const waitpointId = `waitpoint_${CUID_25}`; // cuid waitpoint id → would route to #legacy by id-shape

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap6_new",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      // The lazy `getOrCreateRunWaitpoint` create shape: a RUN waitpoint pointing back at its run.
      await router.createWaitpoint({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap6",
          type: "RUN",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedByTaskRunId: runId,
        },
      });

      // Co-resides with the ksuid run on #new (NOT stranded on #legacy by the cuid id-shape).
      const onNew = await prisma17.waitpoint.findUnique({ where: { id: waitpointId } });
      expect(onNew).not.toBeNull();
      const onLegacy = await prisma14.waitpoint.findUnique({ where: { id: waitpointId } });
      expect(onLegacy).toBeNull();

      // And the run-completion hydrate (associatedWaitpoint by completedByTaskRunId on the run's DB)
      // now resolves it — proving the parent would resume rather than hang.
      const run = await router.findRun({ id: runId }, { include: { associatedWaitpoint: true } });
      expect((run as any).associatedWaitpoint?.id).toBe(waitpointId);
    }
  );

  // Control: a cuid run's lazy RUN-waitpoint co-resides on #legacy with the run.
  heteroRunOpsPostgresTest(
    "control: a cuid run's lazy RUN-waitpoint co-resides on #legacy",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "gap6c_leg");
      const runId = `run_${CUID_25}`; // cuid run → #legacy
      const waitpointId = `waitpoint_${KSUID_27}`; // ksuid waitpoint id → would route to #new by id-shape

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap6c_legacy",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      await router.createWaitpoint({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap6c",
          type: "RUN",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
          completedByTaskRunId: runId,
        },
      });

      const onLegacy = await prisma14.waitpoint.findUnique({ where: { id: waitpointId } });
      expect(onLegacy).not.toBeNull();
      const onNew = await prisma17.waitpoint.findUnique({ where: { id: waitpointId } });
      expect(onNew).toBeNull();
    }
  );

  // ===========================================================================================
  // Snapshot resume payload must not lose a cross-DB waitpoint's OUTPUT.
  // `findLatestExecutionSnapshot` hydrates `completedWaitpoints` from the
  // snapshot's own (run's) client. A ksuid run resumed by a waitpoint that completed on the OTHER DB
  // (cuid token) would get the token hydrated to a stale/absent row → its OUTPUT silently vanishes from
  // the resume payload (a wrong-result, not just a wrong dashboard). Fix: the router re-resolves the
  // snapshot's completed waitpoints across BOTH DBs.
  // ===========================================================================================

  // A ksuid run's latest snapshot lists a completed waitpoint that lives on #legacy
  // (cross-DB). The single #new store hydrates it null; the router recovers its real OUTPUT.
  heteroRunOpsPostgresTest(
    "findLatestExecutionSnapshot recovers a cross-DB completed waitpoint's OUTPUT via the router",
    async ({ prisma14, prisma17 }) => {
      const { router, newStore } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "cg1_new");
      const legEnv = await seedEnvironment(prisma14, "legacy", "cg1_leg");
      const runId = `run_${KSUID_27}`; // ksuid run → #new
      const waitpointId = `waitpoint_${CUID_25}`; // cuid token → completed on #legacy

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_cg1_new",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          runtimeEnvironmentId: newEnv.environment.id,
        })
      );

      // The completing token lives on #legacy with its OUTPUT.
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_cg1",
          type: "MANUAL",
          status: "COMPLETED",
          output: '{"resumed":"cross-db-output"}',
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });

      // The latest snapshot (on #new, co-resident with the ksuid run) lists the cross-DB token as a
      // completed waitpoint via the CompletedWaitpoint join.
      await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "resumed by cross-db token" },
        completedWaitpoints: [{ id: waitpointId, index: 0 }],
        environmentId: newEnv.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: newEnv.project.id,
        organizationId: newEnv.organization.id,
      });

      // Single-store guard: the #new store alone hydrates the completed waitpoint to nothing (the
      // token is on #legacy) — proving the bug the router fixes.
      const singleStore = await newStore.findLatestExecutionSnapshot(runId);
      const singleWp = singleStore?.completedWaitpoints?.find((w) => w.id === waitpointId);
      expect(singleWp).toBeUndefined();

      // Router path: re-resolves the cross-DB token and surfaces its real OUTPUT on the resume payload.
      const viaRouter = await router.findLatestExecutionSnapshot(runId);
      const recovered = viaRouter?.completedWaitpoints?.find((w) => w.id === waitpointId);
      expect(recovered).toBeDefined();
      expect(recovered!.output).toBe('{"resumed":"cross-db-output"}');
      expect(recovered!.status).toBe("COMPLETED");
    }
  );

  // ===========================================================================================
  // Block-edge WRITER must not require a LOCAL waitpoint row.
  // The design routes the block edge to the RUN's DB and mints standalone tokens on LEGACY, so a
  // ksuid run on #new can legitimately block on a cuid token resident on #legacy (the one tolerated
  // cross-DB direction — the #new `TaskRunWaitpoint` is FK-free precisely for this). If
  // `blockRunWithWaitpointEdges`'s dedicated branch sourced the edge rows from
  // `FROM "Waitpoint" w WHERE w.id = ANY(...)`, then when the token is NOT on the run's own DB the
  // SELECT yields 0 rows → 0 edges written on #new → the run blocks at EXECUTING_WITH_WAITPOINTS with
  // no edge → the token's completion (even its own timeout) can never find/resume it → permanent
  // hang. The fix sources the edge rows from the waitpointId array directly (`unnest(...)`), since
  // the #new DB is FK-free on these columns.
  // ===========================================================================================

  // A ksuid run on #new blocking on a cuid token resident on
  // #legacy writes the block edge (TaskRunWaitpoint + WaitpointRunConnection) on #new, NOT requiring
  // the waitpoint row to be local. The #legacy DB holds NO edge for the ksuid run.
  heteroRunOpsPostgresTest(
    "a NEW run blocking on a LEGACY-resident token writes the edge on NEW (no local waitpoint required)",
    async ({ prisma14, prisma17 }) => {
      const { router, newStore } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "gap3b_new");
      const legEnv = await seedEnvironment(prisma14, "legacy", "gap3b_leg");
      const runId = `run_${KSUID_27}`; // ksuid run → #new
      const waitpointId = `waitpoint_${CUID_25}`; // cuid standalone token → resides on #legacy

      // The ksuid run lives on #new.
      await prisma17.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_gap3b_new",
          runtimeEnvironmentId: newEnv.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${runId}`,
          spanId: `span_${runId}`,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      // The standalone token (minted on LEGACY) lives on #legacy ONLY — it is NOT on #new.
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap3b",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });

      // Route the block edge by the blocked RUN's id → #new. The token is NOT local to #new,
      // but the #new TaskRunWaitpoint is FK-free, so the edge MUST still be written.
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: newEnv.project.id,
      });

      // The block edge is written on #new (co-resident with the run) — a local-waitpoint join writes 0.
      const edgesOnNew = await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } });
      expect(edgesOnNew).toBe(1);
      // The historical WaitpointRunConnection is also written on #new.
      const connectionsOnNew = await prisma17.waitpointRunConnection.count({
        where: { taskRunId: runId },
      });
      expect(connectionsOnNew).toBe(1);
      // The #legacy DB holds NO edge for the ksuid run (the safety invariant: no cross-ref on LEGACY).
      const edgesOnLegacy = await prisma14.taskRunWaitpoint.count({ where: { taskRunId: runId } });
      expect(edgesOnLegacy).toBe(0);

      // And the edge is discoverable by the token's completion fan-out: a read keyed on the
      // token's waitpointId via the router finds the #new-resident edge, so completing the LEGACY
      // token would resume the NEW run rather than hang.
      const byWaitpoint = await router.findManyTaskRunWaitpoints({
        where: { waitpointId },
        select: { id: true, taskRunId: true },
      });
      expect(byWaitpoint.map((e) => e.taskRunId)).toContain(runId);

      // Single-store cross-check: the #new store ALSO writes the edge directly (proving the fix is in
      // the store writer, not only the router routing).
      const runId2 = `run_${"m".repeat(27)}`; // a second ksuid run on #new
      await prisma17.taskRun.create({
        data: {
          id: runId2,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_gap3b_new2",
          runtimeEnvironmentId: newEnv.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${runId2}`,
          spanId: `span_${runId2}`,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await newStore.blockRunWithWaitpointEdges({
        runId: runId2,
        waitpointIds: [waitpointId],
        projectId: newEnv.project.id,
      });
      const edgesOnNew2 = await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId2 } });
      expect(edgesOnNew2).toBe(1);
    }
  );

  // Co-resident control: a ksuid run blocking on a CO-RESIDENT ksuid token still writes the
  // edge on #new (proving the fix didn't break the co-resident case the old join handled).
  heteroRunOpsPostgresTest(
    "control: a NEW run blocking on a CO-RESIDENT NEW token writes the edge on NEW",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "gap3bco_new");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${KSUID_27}`; // ksuid token → co-resident on #new

      await prisma17.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_gap3bco_new",
          runtimeEnvironmentId: env.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: env.organization.id,
          projectId: env.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${runId}`,
          spanId: `span_${runId}`,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap3bco",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });

      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: env.project.id,
      });

      const edgesOnNew = await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } });
      expect(edgesOnNew).toBe(1);
      const connectionsOnNew = await prisma17.waitpointRunConnection.count({
        where: { taskRunId: runId },
      });
      expect(connectionsOnNew).toBe(1);
    }
  );

  // Idempotency control: a duplicate block (ON CONFLICT DO NOTHING) must not create a second
  // edge — the crash-recovery / retry contract (the engine re-writes the same edge on retry).
  heteroRunOpsPostgresTest(
    "a duplicate cross-DB block edge is idempotent (ON CONFLICT DO NOTHING)",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "gap3bidem_new");
      const legEnv = await seedEnvironment(prisma14, "legacy", "gap3bidem_leg");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${CUID_25}`; // cuid token → #legacy

      await prisma17.taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_gap3bidem_new",
          runtimeEnvironmentId: newEnv.environment.id,
          environmentType: "DEVELOPMENT",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          traceContext: {},
          traceId: `trace_${runId}`,
          spanId: `span_${runId}`,
          queue: "task/my-task",
          isTest: false,
          taskEventStore: "taskEvent",
          depth: 0,
        },
      });
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap3bidem",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });

      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: newEnv.project.id,
      });
      // Replay the same write (a retry after a crash between the edge write and the snapshot flip).
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: newEnv.project.id,
      });

      const edgesOnNew = await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } });
      expect(edgesOnNew).toBe(1);
      const connectionsOnNew = await prisma17.waitpointRunConnection.count({
        where: { taskRunId: runId },
      });
      expect(connectionsOnNew).toBe(1);
    }
  );

  // Control: a co-resident completed waitpoint (token + run on #new) is unaffected — the router
  // re-resolution is idempotent.
  heteroRunOpsPostgresTest(
    "control: a co-resident completed waitpoint's OUTPUT is preserved through the router",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "cg1c_new");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${KSUID_27}`; // co-resident on #new

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_cg1c_new",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_cg1c",
          type: "MANUAL",
          status: "COMPLETED",
          output: '{"resumed":"co-resident-output"}',
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });
      await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "resumed by co-resident token" },
        completedWaitpoints: [{ id: waitpointId, index: 0 }],
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });

      const viaRouter = await router.findLatestExecutionSnapshot(runId);
      const recovered = viaRouter?.completedWaitpoints?.find((w) => w.id === waitpointId);
      expect(recovered).toBeDefined();
      expect(recovered!.output).toBe('{"resumed":"co-resident-output"}');
    }
  );

  // ===========================================================================================
  // `getWaitpoint`'s WAITPOINT_DEDICATED relations
  // ({ blockingTaskRuns, connectedRuns, completedExecutionSnapshots }) are hydrated by the dedicated
  // store on its OWN client only (PostgresRunStore.findWaitpoint → WAITPOINT_DEDICATED
  // hydrators, all keyed by `waitpointId` on the store's single client). But a
  // waitpoint's blocking edge, run connection and completing snapshot all CO-LOCATE WITH THE RUN
  // (blockRunWithWaitpointEdges routes by runId; the CompletedWaitpoint + WaitpointRunConnection
  // join rows are written on the run's DB). A cuid token blocking
  // a ksuid run therefore has every group-A TARGET on the OTHER DB → the single-client hydrator finds
  // nothing → engine.getWaitpoint (include blockingTaskRuns→taskRun) silently returns an
  // empty `blockingTaskRuns`. Fix: the router (RoutingRunStore.findWaitpoint/findManyWaitpoints) strips
  // these relation keys from the per-leg query and re-resolves the targets across BOTH DBs, mirroring
  // findManyTaskRunWaitpoints' edge fan-out.
  // ===========================================================================================

  // A cuid token on #legacy blocking a ksuid run on #new. The block edge + run connection live
  // on #new (the run's DB). getWaitpoint's include{ blockingTaskRuns: { select: { taskRun } } } must
  // surface the cross-DB blocked run. Single-store guard proves the #legacy hydrator alone misses it.
  heteroRunOpsPostgresTest(
    "findWaitpoint include blockingTaskRuns surfaces a cross-DB blocked run via the router",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "gap13bt_new");
      const legEnv = await seedEnvironment(prisma14, "legacy", "gap13bt_leg");
      const runId = `run_${KSUID_27}`; // ksuid run → #new
      const waitpointId = `waitpoint_${CUID_25}`; // cuid token → #legacy

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap13bt_new",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          runtimeEnvironmentId: newEnv.environment.id,
        })
      );
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap13bt",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });

      // Real production write path: the edge + WaitpointRunConnection land on the RUN's DB (#new).
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: newEnv.project.id,
      });

      // Residency sanity: the edge and connection are on #new only; the token is on #legacy only.
      expect(await prisma17.taskRunWaitpoint.count({ where: { waitpointId } })).toBe(1);
      expect(await prisma14.taskRunWaitpoint.count({ where: { waitpointId } })).toBe(0);
      expect(await prisma17.waitpoint.count({ where: { id: waitpointId } })).toBe(0);
      expect(await prisma14.waitpoint.count({ where: { id: waitpointId } })).toBe(1);

      // Single-store guard: the #legacy store (where the token lives) hydrates blockingTaskRuns from its
      // own client → the edge (on #new) is invisible → empty. This is the bug the router fixes.
      const single = (await legacyStore.findWaitpoint({
        where: { id: waitpointId },
        include: {
          blockingTaskRuns: { select: { taskRun: { select: { id: true, friendlyId: true } } } },
        },
      })) as Record<string, any> | null;
      expect(single?.blockingTaskRuns ?? []).toHaveLength(0);

      // Router path: re-resolves blockingTaskRuns across BOTH DBs → the cross-DB blocked run surfaces.
      const viaRouter = (await router.findWaitpoint({
        where: { id: waitpointId },
        include: {
          blockingTaskRuns: { select: { taskRun: { select: { id: true, friendlyId: true } } } },
        },
      })) as Record<string, any> | null;
      const blocking = viaRouter?.blockingTaskRuns ?? [];
      expect(blocking).toHaveLength(1);
      expect(blocking[0].taskRun?.id).toBe(runId);
      expect(blocking[0].taskRun?.friendlyId).toBe("run_gap13bt_new");
    }
  );

  // Sibling: connectedRuns. The WaitpointRunConnection join is co-resident with the run (#new),
  // so a cuid token's connectedRuns must be re-resolved across BOTH DBs to surface the ksuid run.
  heteroRunOpsPostgresTest(
    "findWaitpoint include connectedRuns surfaces a cross-DB connected run via the router",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "gap13cr_new");
      const legEnv = await seedEnvironment(prisma14, "legacy", "gap13cr_leg");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${CUID_25}`;

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap13cr_new",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          runtimeEnvironmentId: newEnv.environment.id,
        })
      );
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap13cr",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: newEnv.project.id,
      });

      expect(await prisma17.waitpointRunConnection.count({ where: { waitpointId } })).toBe(1);

      // Single-store guard: the token's own store sees no connection (it's on #new).
      const single = (await legacyStore.findWaitpoint({
        where: { id: waitpointId },
        include: { connectedRuns: { select: { id: true, friendlyId: true } } },
      })) as Record<string, any> | null;
      expect(single?.connectedRuns ?? []).toHaveLength(0);

      const viaRouter = (await router.findWaitpoint({
        where: { id: waitpointId },
        include: { connectedRuns: { select: { id: true, friendlyId: true } } },
      })) as Record<string, any> | null;
      const connected = viaRouter?.connectedRuns ?? [];
      expect(connected).toHaveLength(1);
      expect(connected[0].id).toBe(runId);
      expect(connected[0].friendlyId).toBe("run_gap13cr_new");
    }
  );

  // Sibling: completedExecutionSnapshots. The CompletedWaitpoint join is co-resident with the
  // snapshot/run (#new), so a cuid token's completedExecutionSnapshots straddle to #new and must be
  // re-resolved across BOTH DBs.
  heteroRunOpsPostgresTest(
    "findWaitpoint include completedExecutionSnapshots surfaces a cross-DB snapshot via the router",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore } = makeSplitRouter(prisma14, prisma17);
      const newEnv = await seedEnvironment(prisma17, "dedicated", "gap13cs_new");
      const legEnv = await seedEnvironment(prisma14, "legacy", "gap13cs_leg");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${CUID_25}`;

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap13cs_new",
          organizationId: newEnv.organization.id,
          projectId: newEnv.project.id,
          runtimeEnvironmentId: newEnv.environment.id,
        })
      );
      await prisma14.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap13cs",
          type: "MANUAL",
          status: "COMPLETED",
          output: '{"done":true}',
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: legEnv.project.id,
          environmentId: legEnv.environment.id,
        },
      });
      // The snapshot (on #new, co-resident with the ksuid run) records the cross-DB token as completed
      // via the CompletedWaitpoint join.
      const snapshot = await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING", description: "completed by cross-db token" },
        completedWaitpoints: [{ id: waitpointId, index: 0 }],
        environmentId: newEnv.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: newEnv.project.id,
        organizationId: newEnv.organization.id,
      });

      expect(await prisma17.completedWaitpoint.count({ where: { waitpointId } })).toBe(1);

      // Single-store guard: the token's own (#legacy) store sees no completing snapshot (join on #new).
      const single = (await legacyStore.findWaitpoint({
        where: { id: waitpointId },
        include: { completedExecutionSnapshots: { select: { id: true, description: true } } },
      })) as Record<string, any> | null;
      expect(single?.completedExecutionSnapshots ?? []).toHaveLength(0);

      const viaRouter = (await router.findWaitpoint({
        where: { id: waitpointId },
        include: { completedExecutionSnapshots: { select: { id: true, description: true } } },
      })) as Record<string, any> | null;
      const snaps = viaRouter?.completedExecutionSnapshots ?? [];
      expect(snaps).toHaveLength(1);
      expect(snaps[0].id).toBe(snapshot.id);
      expect(snaps[0].description).toBe("completed by cross-db token");
    }
  );

  // Control: a fully co-resident waitpoint (token + run + edge all on #new) is unaffected — the
  // router re-resolution is idempotent and does not double-count or drop the local group-A targets.
  heteroRunOpsPostgresTest(
    "control: a co-resident waitpoint's blockingTaskRuns/connectedRuns are preserved through the router",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "gap13ctl_new");
      const runId = `run_${KSUID_27}`;
      const waitpointId = `waitpoint_${KSUID_27}`; // co-resident on #new

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_gap13ctl_new",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );
      await prisma17.waitpoint.create({
        data: {
          id: waitpointId,
          friendlyId: "wp_gap13ctl",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: `idem_${waitpointId}`,
          userProvidedIdempotencyKey: false,
          projectId: env.project.id,
          environmentId: env.environment.id,
        },
      });
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [waitpointId],
        projectId: env.project.id,
      });

      const viaRouter = (await router.findWaitpoint({
        where: { id: waitpointId },
        include: {
          blockingTaskRuns: { select: { taskRun: { select: { id: true } } } },
          connectedRuns: { select: { id: true } },
        },
      })) as Record<string, any> | null;
      expect(viaRouter?.blockingTaskRuns ?? []).toHaveLength(1);
      expect(viaRouter!.blockingTaskRuns[0].taskRun?.id).toBe(runId);
      expect((viaRouter?.connectedRuns ?? []).map((r: any) => r.id)).toEqual([runId]);
    }
  );
});

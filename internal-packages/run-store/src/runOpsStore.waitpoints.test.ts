// RunStore run-ops persistence — waitpoints, against the REAL dedicated split topology.
//
// `heteroRunOpsPostgresTest` gives prisma14 = the full control-plane schema (#legacy) and
// prisma17 = a real `RunOpsPrismaClient` over the @internal/run-ops-database SUBSET schema (#new).
// These were previously on the weaker `heteroPostgresTest` (full schema on BOTH sides), which could
// not catch dedicated-subset behaviour differences — the entire point of the split. On the subset
// there are no Organization/Project/RuntimeEnvironment models and the implicit M2M join tables
// (`_WaitpointRunConnections`) are replaced by the explicit FK-free `WaitpointRunConnection` model,
// so the store's blocking/completion paths must behave identically whether backed by the legacy
// implicit M2M or the dedicated explicit join.

import { heteroRunOpsPostgresTest, HETERO_PINNED_ICU_COLLATION } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by the version char after stripping a single leading `<prefix>_`: a v1 body
// → run-ops id → NEW (#new / dedicated subset), 25 chars → cuid → LEGACY (#legacy / full schema).
const NEW_ID_26 = "k".repeat(24) + "01";
const CUID_25 = "c".repeat(25);

// On the dedicated subset there are no Organization/Project/RuntimeEnvironment models (the run-ops
// rows carry FK-free scalar ids), so we mint synthetic owning ids. On legacy we seed the real rows
// the kept FKs require.
async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  slugSuffix: string
) {
  if (schemaVariant === "dedicated") {
    return {
      organization: { id: `org_${slugSuffix}` },
      project: { id: `proj_${slugSuffix}` },
      environment: { id: `env_${slugSuffix}` },
    };
  }
  const organization = await (prisma as PrismaClient).organization.create({
    data: { title: `Org ${slugSuffix}`, slug: `org-${slugSuffix}` },
  });
  const project = await (prisma as PrismaClient).project.create({
    data: {
      name: `Project ${slugSuffix}`,
      slug: `project-${slugSuffix}`,
      externalRef: `proj_${slugSuffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await (prisma as PrismaClient).runtimeEnvironment.create({
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
  parentTaskRunId?: string;
  rootTaskRunId?: string;
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
      ...(params.parentTaskRunId && { parentTaskRunId: params.parentTaskRunId }),
      ...(params.rootTaskRunId && { rootTaskRunId: params.rootTaskRunId }),
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

async function seedPendingWaitpoint(
  prisma: AnyClient,
  params: {
    id: string;
    friendlyId: string;
    projectId: string;
    environmentId: string;
    type?: "MANUAL" | "RUN";
    completedByTaskRunId?: string;
  }
) {
  return (prisma as PrismaClient).waitpoint.create({
    data: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: params.type ?? "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${params.id}`,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
      ...(params.completedByTaskRunId && { completedByTaskRunId: params.completedByTaskRunId }),
    },
  });
}

function makeStore(prisma: AnyClient, schemaVariant: RunStoreSchemaVariant) {
  return new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant,
  });
}

// Count the run↔waitpoint connection rows for (runId, waitpointId), reading from whichever physical
// connection table the store writes: the implicit `_WaitpointRunConnections` M2M on #legacy, the
// explicit FK-free `WaitpointRunConnection` model on the dedicated #new subset.
async function countConnection(
  prisma: AnyClient,
  schemaVariant: RunStoreSchemaVariant,
  runId: string,
  waitpointId: string
): Promise<number> {
  const rows =
    schemaVariant === "dedicated"
      ? await (prisma as PrismaClient).$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT COUNT(*)::bigint as count FROM "WaitpointRunConnection" WHERE "taskRunId" = '${runId}' AND "waitpointId" = '${waitpointId}'`
        )
      : await (prisma as PrismaClient).$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT COUNT(*)::bigint as count FROM "_WaitpointRunConnections" WHERE "A" = '${runId}' AND "B" = '${waitpointId}'`
        );
  return Number(rows.at(0)?.count ?? 0);
}

// Strip per-DB / prisma-managed fields so completed waitpoint rows compare field-for-field.
function normalizeWaitpoint(row: Record<string, unknown>) {
  const r = { ...row };
  delete r.id;
  delete r.friendlyId;
  delete r.idempotencyKey;
  delete r.completedAt;
  delete r.createdAt;
  delete r.updatedAt;
  delete r.projectId;
  delete r.environmentId;
  return r;
}

describe("RunStore run-ops persistence — waitpoints", () => {
  // a PENDING waitpoint blocked then completed via the store yields a behaviourally-identical
  // completed row on #legacy (full schema) and #new (dedicated subset).
  heteroRunOpsPostgresTest(
    "waitpoint complete is behaviourally identical across #legacy and #new",
    async ({ prisma14, prisma17 }) => {
      const completedAt = new Date("2024-02-02T00:00:00.000Z");

      const run = async (
        prisma: AnyClient,
        schemaVariant: RunStoreSchemaVariant,
        runId: string,
        suffix: string
      ) => {
        const store = makeStore(prisma, schemaVariant);
        const env = await seedEnvironment(prisma, schemaVariant, suffix);
        await store.createRun(
          buildCreateRunInput({
            runId,
            friendlyId: `run_friendly_wa_${suffix}`,
            taskIdentifier: "my-task",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );
        const w = `wp_${suffix}`;
        await seedPendingWaitpoint(prisma, {
          id: w,
          friendlyId: `waitpoint_${suffix}`,
          projectId: env.project.id,
          environmentId: env.environment.id,
        });

        await store.blockRunWithWaitpointEdges({
          runId,
          waitpointIds: [w],
          projectId: env.project.id,
        });
        await store.updateManyWaitpoints({
          where: { id: w },
          data: {
            status: "COMPLETED",
            output: '{"done":true}',
            outputType: "application/json",
            completedAt,
          },
        });

        return store.findWaitpoint({ where: { id: w } });
      };

      const wp14 = await run(prisma14, "legacy", `run_${CUID_25}`, "wa14");
      const wp17 = await run(prisma17, "dedicated", `run_${NEW_ID_26}`, "wa17");

      expect(wp14).not.toBeNull();
      expect(wp17).not.toBeNull();
      expect(wp14!.status).toBe("COMPLETED");
      expect(wp17!.status).toBe("COMPLETED");
      expect(wp14!.completedAt?.toISOString()).toBe(completedAt.toISOString());
      expect(wp17!.completedAt?.toISOString()).toBe(completedAt.toISOString());
      expect(normalizeWaitpoint(wp14 as Record<string, unknown>)).toEqual(
        normalizeWaitpoint(wp17 as Record<string, unknown>)
      );
    }
  );

  // the blocking CTE writes exactly one TaskRunWaitpoint + one connection edge (the implicit
  // `_WaitpointRunConnections` on #legacy, the explicit `WaitpointRunConnection` on #new), is
  // idempotent on a re-run (ON CONFLICT DO NOTHING), and countPendingWaitpoints (the separate MVCC
  // statement) flips 1 → 0 across the completion — identically on both stores.
  heteroRunOpsPostgresTest(
    "blocking CTE round-trips idempotently and pending-count reflects completion",
    async ({ prisma14, prisma17 }) => {
      const run = async (
        prisma: AnyClient,
        schemaVariant: RunStoreSchemaVariant,
        runId: string,
        suffix: string
      ) => {
        const store = makeStore(prisma, schemaVariant);
        const env = await seedEnvironment(prisma, schemaVariant, suffix);
        await store.createRun(
          buildCreateRunInput({
            runId,
            friendlyId: `run_friendly_wb_${suffix}`,
            taskIdentifier: "my-task",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );
        const w = `wp_${suffix}`;
        await seedPendingWaitpoint(prisma, {
          id: w,
          friendlyId: `waitpoint_${suffix}`,
          projectId: env.project.id,
          environmentId: env.environment.id,
        });

        const countEdges = async () => {
          const trw = await store.findManyTaskRunWaitpoints({ where: { taskRunId: runId } });
          const conn = await countConnection(prisma, schemaVariant, runId, w);
          return { trw: trw.length, conn };
        };

        // Pass an explicit batchIndex so the `@@unique([taskRunId, waitpointId, batchIndex])`
        // index engages and the CTE's `ON CONFLICT DO NOTHING` genuinely dedupes the
        // TaskRunWaitpoint row. (With a NULL batchIndex, NULLs are distinct in the unique
        // index, so dedup is handled by a SQL-only partial index that the migration does not
        // ship into the test clone — out of scope for this round-trip proof.)
        const block = () =>
          store.blockRunWithWaitpointEdges({
            runId,
            waitpointIds: [w],
            projectId: env.project.id,
            batchIndex: 0,
          });

        await block();
        const afterFirst = await countEdges();
        const pendingBefore = await store.countPendingWaitpoints([w]);

        // Second call: ON CONFLICT DO NOTHING keeps it at exactly one of each.
        await block();
        const afterSecond = await countEdges();

        await store.updateManyWaitpoints({ where: { id: w }, data: { status: "COMPLETED" } });
        const pendingAfter = await store.countPendingWaitpoints([w]);

        return { afterFirst, afterSecond, pendingBefore, pendingAfter };
      };

      for (const variant of [
        {
          prisma: prisma14,
          schemaVariant: "legacy" as const,
          runId: `run_${CUID_25}`,
          suffix: "wb14",
        },
        {
          prisma: prisma17,
          schemaVariant: "dedicated" as const,
          runId: `run_${NEW_ID_26}`,
          suffix: "wb17",
        },
      ]) {
        const r = await run(variant.prisma, variant.schemaVariant, variant.runId, variant.suffix);
        expect(r.afterFirst).toEqual({ trw: 1, conn: 1 });
        expect(r.afterSecond).toEqual({ trw: 1, conn: 1 });
        expect(r.pendingBefore).toBe(1);
        expect(r.pendingAfter).toBe(0);
      }
    }
  );

  // a small V2 dependency subgraph (parent → child blocked on a RUN-type waitpoint completed by
  // the child) traversed via the store reads produces an identically ordered closure id sequence on
  // #legacy and #new. The load-bearing assertion is ordering parity; the order step is pinned to the
  // shared ICU collation (`und-x-icu`, present on both containers).
  heteroRunOpsPostgresTest(
    "V2 dependency closure ordering is identical across #legacy and #new",
    async ({ prisma14, prisma17 }) => {
      const buildClosure = async (
        prisma: AnyClient,
        schemaVariant: RunStoreSchemaVariant,
        suffix: string
      ) => {
        const store = makeStore(prisma, schemaVariant);
        const env = await seedEnvironment(prisma, schemaVariant, suffix);

        const parentId = "run_parent";
        const childId = "run_child";
        await store.createRun(
          buildCreateRunInput({
            runId: parentId,
            friendlyId: `run_parent_friendly_${suffix}`,
            taskIdentifier: "parent-task",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );
        await store.createRun(
          buildCreateRunInput({
            runId: childId,
            friendlyId: `run_child_friendly_${suffix}`,
            taskIdentifier: "child-task",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
            parentTaskRunId: parentId,
            rootTaskRunId: parentId,
          })
        );

        // A RUN-type waitpoint completed by the child, blocking the parent. The id is
        // version-independent (each DB clone is isolated) so the closure id sequence is
        // directly comparable across the two stores — the friendlyId carries the per-DB suffix
        // to satisfy its global-unique constraint.
        const w = "wp_run_closure";
        await seedPendingWaitpoint(prisma, {
          id: w,
          friendlyId: `waitpoint_run_${suffix}`,
          projectId: env.project.id,
          environmentId: env.environment.id,
          type: "RUN",
          completedByTaskRunId: childId,
        });
        await store.blockRunWithWaitpointEdges({
          runId: parentId,
          waitpointIds: [w],
          projectId: env.project.id,
        });

        // Traverse: parent → its blocking edges → the blocking waitpoints → the run that
        // completes each. Order the closure with explicit COLLATE on the text id step.
        const edges = await store.findManyTaskRunWaitpoints({ where: { taskRunId: parentId } });
        const orderedWaitpointIds = (
          await (prisma as PrismaClient).$queryRawUnsafe<{ id: string }[]>(
            `SELECT "id" FROM "Waitpoint" WHERE "id" IN (${edges
              .map((e) => `'${e.waitpointId}'`)
              .join(",")}) ORDER BY "id" COLLATE "${HETERO_PINNED_ICU_COLLATION}" ASC`
          )
        ).map((r) => r.id);
        const waitpoints = await store.findManyWaitpoints({
          where: { id: { in: orderedWaitpointIds } },
        });
        const completingRunIds = waitpoints
          .map((wp) => wp.completedByTaskRunId)
          .filter((id): id is string => Boolean(id));
        const completingRuns = await store.findRuns({
          where: { id: { in: completingRunIds } },
          orderBy: { id: "asc" },
        });

        return [parentId, ...orderedWaitpointIds, ...completingRuns.map((r) => r.id)];
      };

      const closure14 = await buildClosure(prisma14, "legacy", "wc14");
      const closure17 = await buildClosure(prisma17, "dedicated", "wc17");

      expect(closure14).toEqual(closure17);
      expect(closure14).toEqual(["run_parent", "wp_run_closure", "run_child"]);
    }
  );

  // single-DB passthrough — both router stores are the same #legacy store over one client. A
  // snapshot create + waitpoint block + complete via the router round-trips on that client and never
  // touches the dedicated #new DB (prisma17, the SUBSET schema).
  heteroRunOpsPostgresTest(
    "single-DB binds one client for run-ops (passthrough)",
    async ({ prisma14, prisma17 }) => {
      const store = makeStore(prisma14, "legacy");
      const router = new RoutingRunStore({ new: store, legacy: store });

      const env = await seedEnvironment(prisma14, "legacy", "wd14");

      // NEW_ID_26-length id → NEW residency, exercising the route; both slots are the same store so
      // it still lands on prisma14.
      const runId = `run_${NEW_ID_26}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_passthrough_wd",
          taskIdentifier: "passthrough-task",
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
        })
      );

      const w = "wp_passthrough_wd";
      await seedPendingWaitpoint(prisma14, {
        id: w,
        friendlyId: "waitpoint_passthrough_wd",
        projectId: env.project.id,
        environmentId: env.environment.id,
      });

      const snapshot = await router.createExecutionSnapshot({
        run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
        snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "passthrough" },
        completedWaitpoints: [{ id: w, index: 0 }],
        environmentId: env.environment.id,
        environmentType: "DEVELOPMENT",
        projectId: env.project.id,
        organizationId: env.organization.id,
      });
      await router.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [w],
        projectId: env.project.id,
      });
      await router.updateManyWaitpoints({ where: { id: w }, data: { status: "COMPLETED" } });

      const latest = await router.findLatestExecutionSnapshot(runId);
      expect(latest?.id).toBe(snapshot.id);
      const joinIds = await router.findSnapshotCompletedWaitpointIds(snapshot.id);
      expect(joinIds).toEqual([w]);
      expect(await router.countPendingWaitpoints([w])).toBe(0);

      // Everything landed on the one #legacy client; the dedicated #new DB was never touched.
      expect(await prisma14.taskRun.findUnique({ where: { id: runId } })).not.toBeNull();
      expect(await prisma17.taskRun.findUnique({ where: { id: runId } })).toBeNull();
      expect(await prisma17.waitpoint.findUnique({ where: { id: w } })).toBeNull();
    }
  );

  // the silent-hang case, against the REAL split. A NEW (run-ops id) run is blocked on
  // a LEGACY (cuid) token, so its block edge lives on #new (co-located with the run) while the token's
  // id-shape says LEGACY. Completing that token must FAN OUT the waitpointId edge read across both DBs
  // and find the edge on #new — routing by the token's id-shape (LEGACY) returns zero edges and the
  // run hangs forever. The token is mirrored onto both DBs (the drain window), so #resolveWaitpointStore
  // would resolve it to LEGACY and miss the NEW edge without the fan-out.
  heteroRunOpsPostgresTest(
    "completing a LEGACY token finds a NEW run's edge across both DBs (no silent hang)",
    async ({ prisma14, prisma17 }) => {
      const newStore = makeStore(prisma17, "dedicated");
      const legacyStore = makeStore(prisma14, "legacy");
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      // The NEW run + its (synthetic) env live on the dedicated #new subset (prisma17).
      const env17 = await seedEnvironment(prisma17, "dedicated", "we17");
      const runId = `run_${NEW_ID_26}`; // run-ops id → NEW residency
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_friendly_we",
          taskIdentifier: "my-task",
          organizationId: env17.organization.id,
          projectId: env17.project.id,
          runtimeEnvironmentId: env17.environment.id,
        })
      );

      // A LEGACY (cuid) token, mirrored onto BOTH DBs as during drain. The edge can only be
      // written on #new (the run's DB) because the dedicated block insert sources the edge rows
      // from the waitpointId array directly (FK-free).
      const token = "w".repeat(25); // cuid-length → LEGACY id-shape
      const env14 = await seedEnvironment(prisma14, "legacy", "we14");
      await seedPendingWaitpoint(prisma14, {
        id: token,
        friendlyId: "waitpoint_we_legacy",
        projectId: env14.project.id,
        environmentId: env14.environment.id,
      });
      await seedPendingWaitpoint(prisma17, {
        id: token,
        friendlyId: "waitpoint_we_new",
        projectId: env17.project.id,
        environmentId: env17.environment.id,
      });

      // The edge is written on #new only (co-located with the run).
      await newStore.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [token],
        projectId: env17.project.id,
      });
      expect(await prisma14.taskRunWaitpoint.count({ where: { waitpointId: token } })).toBe(0);
      expect(await prisma17.taskRunWaitpoint.count({ where: { waitpointId: token } })).toBe(1);

      // The completion fan-out (the read completeWaitpoint uses) must find the NEW-DB edge even
      // though the token classifies LEGACY. Pre-fix this returned [] (LEGACY-only) → silent hang.
      const affected = await router.findManyTaskRunWaitpoints({
        where: { waitpointId: token },
        select: { taskRunId: true },
      });
      expect(affected.map((e) => e.taskRunId)).toEqual([runId]);
    }
  );

  // replay / partial-completion safety, against the REAL split. There is NO cross-DB
  // transaction, so a completion can flip the token on one DB while the edge-clear lands on the other
  // (or a job is retried). The unblock recomputes the blocked set from the surviving edges and the
  // edge delete is keyed by (taskRunId, edge ids) — never a blind decrement — so running the
  // read+delete TWICE must not double-count or strand the run: after the first clear there are zero
  // edges, and the second pass is a no-op.
  heteroRunOpsPostgresTest(
    "replaying the unblock clear is idempotent (no double-decrement, no strand)",
    async ({ prisma14, prisma17 }) => {
      const newStore = makeStore(prisma17, "dedicated");
      const legacyStore = makeStore(prisma14, "legacy");
      const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      const env17 = await seedEnvironment(prisma17, "dedicated", "wf17");
      const runId = `run_${NEW_ID_26}`;
      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: "run_friendly_wf",
          taskIdentifier: "my-task",
          organizationId: env17.organization.id,
          projectId: env17.project.id,
          runtimeEnvironmentId: env17.environment.id,
        })
      );

      const token = "x".repeat(25); // LEGACY id-shape, edge co-located on #new
      await seedPendingWaitpoint(prisma17, {
        id: token,
        friendlyId: "waitpoint_wf_new",
        projectId: env17.project.id,
        environmentId: env17.environment.id,
      });
      await newStore.blockRunWithWaitpointEdges({
        runId,
        waitpointIds: [token],
        projectId: env17.project.id,
      });
      await router.updateManyWaitpoints({ where: { id: token }, data: { status: "COMPLETED" } });

      // Drive the continueRunIfUnblocked read+delete shape (by taskRunId) twice.
      const unblockPass = async () => {
        const edges = await router.findManyTaskRunWaitpoints({
          where: { taskRunId: runId },
          select: { id: true, waitpoint: { select: { status: true } } },
        });
        const stillBlocked = edges.some((e) => e.waitpoint.status !== "COMPLETED");
        if (!stillBlocked && edges.length > 0) {
          await router.deleteManyTaskRunWaitpoints({
            where: { taskRunId: runId, id: { in: edges.map((e) => e.id) } },
          });
        }
        return { edgeCount: edges.length, stillBlocked };
      };

      const first = await unblockPass();
      const second = await unblockPass();

      expect(first).toEqual({ edgeCount: 1, stillBlocked: false }); // found + cleared
      expect(second).toEqual({ edgeCount: 0, stillBlocked: false }); // replay is a no-op
      // Edge gone from both DBs; the run is unblocked exactly once, not double-processed.
      expect(await prisma17.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(0);
      expect(await prisma14.taskRunWaitpoint.count({ where: { taskRunId: runId } })).toBe(0);
    }
  );
});

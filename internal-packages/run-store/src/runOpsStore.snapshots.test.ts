// RunStore run-ops persistence — snapshots, against the REAL dedicated split topology.
//
// `heteroRunOpsPostgresTest` gives prisma14 = the full control-plane schema (#legacy) and
// prisma17 = a real `RunOpsPrismaClient` over the @internal/run-ops-database SUBSET schema (#new).
// These were previously on the weaker `heteroPostgresTest` (full schema on BOTH sides), which could
// not catch dedicated-subset behaviour differences — the entire point of the split. On the subset
// there are no Organization/Project/RuntimeEnvironment models and no implicit M2M join tables
// (`_completedWaitpoints` is the explicit `CompletedWaitpoint` model), so the snapshot store must
// behave identically whether backed by the legacy implicit M2M or the dedicated explicit join.
//
// The assertions still compare the store's behaviour across the two physical DBs (control-plane vs
// dedicated): a snapshot created + read through the store yields the same observable result on both.

import { heteroRunOpsPostgresTest, HETERO_PINNED_ICU_COLLATION } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

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

// ownerEngine classifies by the version char after stripping a single leading `<prefix>_`: a v1 body
// → run-ops id → NEW (#new / dedicated run-ops DB subset), 25 chars → cuid → LEGACY (#legacy / full schema).
const NEW_ID_26 = "k".repeat(24) + "01"; // → NEW residency, exercises the dedicated store
const CUID_25 = "c".repeat(25); // → LEGACY residency, exercises the full-schema store

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

async function seedPendingWaitpoint(
  prisma: AnyClient,
  params: { id: string; friendlyId: string; projectId: string; environmentId: string }
) {
  return (prisma as PrismaClient).waitpoint.create({
    data: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${params.id}`,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
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

// Strip the prisma-managed / per-DB id fields so two rows born on different physical DBs
// (legacy full schema vs dedicated subset) compare field-for-field for behavioural parity.
function normalizeSnapshot(row: Record<string, unknown>) {
  const r = { ...row };
  delete r.id;
  delete r.runId;
  delete r.previousSnapshotId;
  delete r.createdAt;
  delete r.updatedAt;
  delete r.environmentId;
  delete r.projectId;
  delete r.organizationId;
  return r;
}

describe("RunStore run-ops persistence — snapshots", () => {
  // an identical run + ≥2 snapshots (one invalid, one valid) seeded on #legacy (full schema)
  // and #new (dedicated subset) yield a deep-equal `findLatestExecutionSnapshot` row, and it is the
  // valid one — proving the dedicated store's group-A hydration does not perturb the scalar columns.
  heteroRunOpsPostgresTest(
    "snapshot findLatest is behaviourally identical across #legacy and #new",
    async ({ prisma14, prisma17 }) => {
      const seed = async (
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
            friendlyId: `run_friendly_latest_${suffix}`,
            taskIdentifier: "my-task",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );

        const ids = {
          environmentId: env.environment.id,
          environmentType: "DEVELOPMENT" as const,
          projectId: env.project.id,
          organizationId: env.organization.id,
        };

        // An invalid snapshot (error set) that must NOT be returned by findLatest.
        await store.createExecutionSnapshot({
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING", description: "invalid one" },
          error: "boom",
          ...ids,
        });
        // The valid snapshot created last — this is the one findLatest must return.
        const valid = await store.createExecutionSnapshot({
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "valid latest" },
          ...ids,
        });
        return { store, validId: valid.id };
      };

      const legacyRunId = `run_${CUID_25}`; // → #legacy (full schema)
      const newRunId = `run_${NEW_ID_26}`; // → #new (dedicated subset)
      const seed14 = await seed(prisma14, "legacy", legacyRunId, "sa14");
      const seed17 = await seed(prisma17, "dedicated", newRunId, "sa17");

      const latest14 = await seed14.store.findLatestExecutionSnapshot(legacyRunId);
      const latest17 = await seed17.store.findLatestExecutionSnapshot(newRunId);

      expect(latest14).not.toBeNull();
      expect(latest17).not.toBeNull();
      // The valid snapshot wins over the earlier invalid one.
      expect(latest14!.id).toBe(seed14.validId);
      expect(latest17!.id).toBe(seed17.validId);
      expect(latest14!.isValid).toBe(true);
      expect(latest14!.description).toBe("valid latest");
      expect(latest17!.isValid).toBe(true);
      expect(latest17!.description).toBe("valid latest");

      // Compare the persisted columns (drop relation arrays + per-DB ids). The dedicated store
      // hydrates `completedWaitpoints` from the explicit CompletedWaitpoint join, the legacy store
      // from the implicit M2M — both stripped here, leaving the scalar columns to compare.
      const strip = (
        row: NonNullable<Awaited<ReturnType<PostgresRunStore["findLatestExecutionSnapshot"]>>>
      ) => {
        const { completedWaitpoints, checkpoint, ...rest } = row;
        return normalizeSnapshot(rest as Record<string, unknown>);
      };
      expect(strip(latest14!)).toEqual(strip(latest17!));
    }
  );

  // completedWaitpoints round-trips through the join (implicit `_completedWaitpoints` on legacy,
  // explicit `CompletedWaitpoint` on the dedicated subset), and the derived completedWaitpointOrder
  // preserves the supplied index order, on both stores.
  heteroRunOpsPostgresTest(
    "completedWaitpoints round-trip preserves order across #legacy and #new",
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
            friendlyId: `run_friendly_cw_${suffix}`,
            taskIdentifier: "my-task",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );

        const w1 = `wp_${suffix}_1`;
        const w2 = `wp_${suffix}_2`;
        await seedPendingWaitpoint(prisma, {
          id: w1,
          friendlyId: `waitpoint_${suffix}_1`,
          projectId: env.project.id,
          environmentId: env.environment.id,
        });
        await seedPendingWaitpoint(prisma, {
          id: w2,
          friendlyId: `waitpoint_${suffix}_2`,
          projectId: env.project.id,
          environmentId: env.environment.id,
        });

        const snapshot = await store.createExecutionSnapshot({
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: {
            executionStatus: "EXECUTING_WITH_WAITPOINTS",
            description: "with waitpoints",
          },
          completedWaitpoints: [
            { id: w1, index: 0 },
            { id: w2, index: 1 },
          ],
          environmentId: env.environment.id,
          environmentType: "DEVELOPMENT",
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        const joinIds = await store.findSnapshotCompletedWaitpointIds(snapshot.id);
        return { w1, w2, joinIds, order: snapshot.completedWaitpointOrder };
      };

      const r14 = await run(prisma14, "legacy", `run_${CUID_25}`, "sb14");
      const r17 = await run(prisma17, "dedicated", `run_${NEW_ID_26}`, "sb17");

      // The join links the snapshot to both waitpoints (set-equal) on both stores.
      expect([...r14.joinIds].sort()).toEqual([r14.w1, r14.w2].sort());
      expect([...r17.joinIds].sort()).toEqual([r17.w1, r17.w2].sort());

      // The derived order column reflects the supplied index order, identically per store.
      expect(r14.order).toEqual([r14.w1, r14.w2]);
      expect(r17.order).toEqual([r17.w1, r17.w2]);
    }
  );

  // a collation-sensitive ORDER BY over a text column pinned to the shared ICU collation
  // (`und-x-icu`, present on both the #legacy container and the #new container) returns the
  // identical sequence of snapshot descriptions on #legacy and #new. The pin keeps the comparison a
  // proof of the split rather than of a default-collation difference between the two DBs.
  heteroRunOpsPostgresTest(
    "snapshot ORDER BY pinned to the shared ICU collation is identical across #legacy and #new",
    async ({ prisma14, prisma17 }) => {
      const descriptions = ["Zebra", "apple", "Apple", "éclair", "banana", "_underscore"];

      const seed = async (
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
            friendlyId: `run_friendly_order_${suffix}`,
            taskIdentifier: "my-task",
            organizationId: env.organization.id,
            projectId: env.project.id,
            runtimeEnvironmentId: env.environment.id,
          })
        );
        for (const description of descriptions) {
          await store.createExecutionSnapshot({
            run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
            snapshot: { executionStatus: "EXECUTING", description },
            environmentId: env.environment.id,
            environmentType: "DEVELOPMENT",
            projectId: env.project.id,
            organizationId: env.organization.id,
          });
        }
      };

      await seed(prisma14, "legacy", `run_${CUID_25}`, "sc14");
      await seed(prisma17, "dedicated", `run_${NEW_ID_26}`, "sc17");

      const orderedDescriptions = async (client: AnyClient) => {
        const rows = await (client as PrismaClient).$queryRawUnsafe<{ description: string }[]>(
          `SELECT "description" FROM "TaskRunExecutionSnapshot" WHERE "description" != 'Run was created' ORDER BY "description" COLLATE "${HETERO_PINNED_ICU_COLLATION}" ASC`
        );
        return rows.map((r) => r.description);
      };

      const ordered14 = await orderedDescriptions(prisma14);
      const ordered17 = await orderedDescriptions(prisma17);

      expect(ordered14).toEqual(ordered17);
      expect(ordered14).toHaveLength(descriptions.length);
    }
  );
});

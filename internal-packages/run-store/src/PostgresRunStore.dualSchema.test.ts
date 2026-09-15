import { heteroPostgresTest, heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import type { CreateRunInput, RunAssociatedWaitpointInput } from "./types.js";

// The store's structural client accepts either backing Prisma client; the two generated
// clients are nominally distinct so we widen at the boundary, exactly as buildRunStore does.
type AnyClient = PrismaClient | RunOpsPrismaClient;

// The dedicated subset schema has no Organization/Project/RuntimeEnvironment models and the
// run-ops TaskRun/Waitpoint carry FK-free scalar ids, so on that variant we mint synthetic
// ids; on legacy we seed the real owning rows the FKs require.
async function seedEnvironment(
  prisma: AnyClient,
  schemaVariant: "legacy" | "dedicated",
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

function buildAssociatedWaitpoint(params: {
  id: string;
  friendlyId: string;
  projectId: string;
  environmentId: string;
}): RunAssociatedWaitpointInput {
  return {
    id: params.id,
    friendlyId: params.friendlyId,
    type: "RUN",
    status: "PENDING",
    idempotencyKey: `idem_${params.id}`,
    userProvidedIdempotencyKey: false,
    projectId: params.projectId,
    environmentId: params.environmentId,
  };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  taskIdentifier: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  associatedWaitpoint?: RunAssociatedWaitpointInput;
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
    associatedWaitpoint: params.associatedWaitpoint,
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

// Strip the prisma-managed / connection-volatile columns so two waitpoint rows born on
// different physical DBs (and via different code paths) compare field-for-field.
function normalizeWaitpoint(row: Record<string, unknown> | null) {
  if (!row) return row;
  const r = { ...row };
  delete r.createdAt;
  delete r.updatedAt;
  return r;
}

// Runs the same createRun + snapshot scenario against any (client, schemaVariant) pair and
// returns the observable shapes the interface contract promises, so the legacy and dedicated
// runs can be asserted equivalent.
async function runScenario(
  prisma: AnyClient,
  schemaVariant: "legacy" | "dedicated",
  suffix: string
) {
  const store = new PostgresRunStore({
    prisma: prisma as never,
    readOnlyPrisma: prisma as never,
    schemaVariant,
  });
  const env = await seedEnvironment(prisma, schemaVariant, suffix);

  const runId = `run_dual_${suffix}`;
  const created = await store.createRun(
    buildCreateRunInput({
      runId,
      friendlyId: `run_friendly_${suffix}`,
      taskIdentifier: "my-task",
      organizationId: env.organization.id,
      projectId: env.project.id,
      runtimeEnvironmentId: env.environment.id,
      associatedWaitpoint: buildAssociatedWaitpoint({
        id: `wp_assoc_${suffix}`,
        friendlyId: `waitpoint_assoc_${suffix}`,
        projectId: env.project.id,
        environmentId: env.environment.id,
      }),
    })
  );

  // The run read that pulls the associatedWaitpoint back (rewriteDebouncedRun shape).
  const rewritten = await store.rewriteDebouncedRun(runId, {
    payload: '{"hello":"again"}',
    payloadType: "application/json",
  });

  // Two pending waitpoints to complete via a snapshot.
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

  const ids = {
    environmentId: env.environment.id,
    environmentType: "DEVELOPMENT" as const,
    projectId: env.project.id,
    organizationId: env.organization.id,
  };

  const snapshot = await store.createExecutionSnapshot({
    run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING_WITH_WAITPOINTS", description: "with waitpoints" },
    completedWaitpoints: [
      { id: w2, index: 1 },
      { id: w1, index: 0 },
    ],
    ...ids,
  });

  const latest = await store.findLatestExecutionSnapshot(runId);
  const joinIds = await store.findSnapshotCompletedWaitpointIds(snapshot.id);

  return {
    runId,
    created,
    rewritten,
    snapshot,
    latest,
    joinIds,
    waitpointId: `wp_assoc_${suffix}`,
    w1,
    w2,
  };
}

function assertScenario(r: Awaited<ReturnType<typeof runScenario>>) {
  // createRun returns the run with its associatedWaitpoint hydrated.
  expect(r.created.id).toBe(r.runId);
  expect(r.created.associatedWaitpoint).not.toBeNull();
  expect(r.created.associatedWaitpoint!.id).toBe(r.waitpointId);
  expect(r.created.associatedWaitpoint!.type).toBe("RUN");
  expect(r.created.associatedWaitpoint!.completedByTaskRunId).toBe(r.runId);

  // The run read hydrates the same associatedWaitpoint.
  expect(r.rewritten.associatedWaitpoint).not.toBeNull();
  expect(r.rewritten.associatedWaitpoint!.id).toBe(r.waitpointId);

  // The snapshot create derives completedWaitpointOrder by index (w1 index 0, w2 index 1).
  expect(r.snapshot.completedWaitpointOrder).toEqual([r.w1, r.w2]);

  // The join read returns both completed waitpoints (set-equal).
  expect([...r.joinIds].sort()).toEqual([r.w1, r.w2].sort());

  // findLatest hydrates completedWaitpoints (set-equal) and the (null) checkpoint.
  expect(r.latest).not.toBeNull();
  expect(r.latest!.id).toBe(r.snapshot.id);
  expect(r.latest!.checkpoint).toBeNull();
  expect(r.latest!.completedWaitpoints.map((w) => w.id).sort()).toEqual([r.w1, r.w2].sort());
}

describe("PostgresRunStore dual-schema (P2-store-bodies)", () => {
  // Legacy variant over the full @trigger.dev/database schema — existing behavior must hold.
  heteroPostgresTest(
    "createRun + snapshot relation ops work on the LEGACY client (schemaVariant=legacy)",
    async ({ prisma14 }) => {
      const r = await runScenario(prisma14, "legacy", "leg");
      assertScenario(r);
    }
  );

  // Dedicated variant over the @internal/run-ops-database SUBSET schema — RED before this
  // task (Prisma validation error on associatedWaitpoint/completedWaitpoints), GREEN after.
  heteroRunOpsPostgresTest(
    "createRun + snapshot relation ops work on the DEDICATED RunOpsPrismaClient (schemaVariant=dedicated)",
    async ({ prisma17 }) => {
      const r = await runScenario(prisma17, "dedicated", "ded");
      assertScenario(r);
    }
  );

  // Cross-variant equivalence: the observable return contract is the same regardless of which
  // backing schema produced it.
  heteroRunOpsPostgresTest(
    "legacy and dedicated produce equivalent return shapes",
    async ({ prisma14, prisma17 }) => {
      const legacy = await runScenario(prisma14, "legacy", "xleg");
      const dedicated = await runScenario(prisma17, "dedicated", "xded");

      // Associated waitpoint: normalize per-DB volatile columns, the rest must match.
      const legW = normalizeWaitpoint(
        legacy.created.associatedWaitpoint as unknown as Record<string, unknown>
      );
      const dedW = normalizeWaitpoint(
        dedicated.created.associatedWaitpoint as unknown as Record<string, unknown>
      );
      // Both carry the same friendlyId/type/status/completedByTaskRunId-shaped contract;
      // ids differ by suffix so compare the structural keys that must agree.
      expect(legW!.type).toEqual(dedW!.type);
      expect(legW!.status).toEqual(dedW!.status);
      expect((legW as Record<string, unknown>).outputType).toEqual(
        (dedW as Record<string, unknown>).outputType
      );

      // completedWaitpointOrder derivation is variant-independent.
      expect(legacy.snapshot.completedWaitpointOrder.length).toEqual(
        dedicated.snapshot.completedWaitpointOrder.length
      );
      expect(legacy.latest!.completedWaitpoints.length).toEqual(
        dedicated.latest!.completedWaitpoints.length
      );
    }
  );

  // expireRunsBatch dedicated-fixture: RED before fix (Prisma.join mis-binds on dedicated client
  // → 42601-class error), GREEN after (= ANY(ids::text[]) path).
  heteroRunOpsPostgresTest(
    "expireRunsBatch sets EXPIRED on the DEDICATED RunOpsPrismaClient (schemaVariant=dedicated)",
    async ({ prisma17 }) => {
      const store = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });

      // Dedicated subset has no Organization/Project/RuntimeEnvironment tables — use synthetic ids.
      const orgId = "org_expbatch_ded";
      const projId = "proj_expbatch_ded";
      const envId = "env_expbatch_ded";

      const runId1 = "run_expbatch_ded_1";
      const runId2 = "run_expbatch_ded_2";

      for (const id of [runId1, runId2]) {
        await prisma17.taskRun.create({
          data: {
            id,
            engine: "V2",
            status: "PENDING",
            friendlyId: `friendly_${id}`,
            runtimeEnvironmentId: envId,
            environmentType: "DEVELOPMENT",
            organizationId: orgId,
            projectId: projId,
            taskIdentifier: "my-task",
            payload: "{}",
            payloadType: "application/json",
            traceContext: {},
            traceId: `trace_${id}`,
            spanId: `span_${id}`,
            queue: "task/my-task",
            isTest: false,
            taskEventStore: "taskEvent",
            depth: 0,
          },
        });
      }

      const now = new Date("2026-06-01T12:00:00.000Z");
      const error = {
        type: "STRING_ERROR" as const,
        raw: "Run expired because the TTL was reached",
      };

      const count = await store.expireRunsBatch([runId1, runId2], { error, now });

      expect(count).toBe(2);

      for (const id of [runId1, runId2]) {
        const row = await prisma17.taskRun.findUniqueOrThrow({
          where: { id },
          select: { status: true, completedAt: true, expiredAt: true, updatedAt: true },
        });
        expect(row.status).toBe("EXPIRED");
        expect(row.completedAt).toEqual(now);
        expect(row.expiredAt).toEqual(now);
        expect(row.updatedAt).toEqual(now);
      }
    }
  );
});

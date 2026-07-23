// Property: a GLOBAL-scope idempotency key (per environment+task, NOT per parent) maps to exactly ONE
// child run even when triggered from two parents of DIFFERENT residency. The dedup client is routed by
// the PARENT run's residency (NEW parent → NEW DB, LEGACY parent → LEGACY DB), and the trigger hot path
// probes runStore.findRun({env, idempotencyKey, task}) before minting. Exercised on the REAL
// two-physical-DB split (heteroRunOpsPostgresTest, never mocked): drives the actual
// RoutingRunStore.findRun probe (dedup client chosen by parent residency) + createRun mint in real
// sequential trigger order, asserting one child — the id-less findRun fans out across BOTH DBs, so the
// second probe sees the first child. A routing/topology property, not replica lag.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient, PrismaClientOrTransaction } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;
type Residency = "NEW" | "LEGACY";

// ownerEngine classifies by internal-id LENGTH after stripping a leading `<prefix>_`:
// 25 chars (no internal underscore) → cuid → LEGACY (#legacy / prisma14),
// a v1 body (version "1" at index 25) → run-ops id → NEW (#new / prisma17).
function cuidLegacy(seed: string): string {
  return (seed + "c".repeat(25)).slice(0, 25); // 25 chars → LEGACY
}
function runOpsNew(seed: string): string {
  return (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01";
}

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

// One logical environment whose scalar env/project/org ids are shared by both physical DBs, with real
// owning rows seeded on #legacy (kept FKs) and the same scalar ids valid on the FK-free #new subset.
async function seedSharedEnv(prisma14: PrismaClient, suffix: string) {
  const legacy = await seedEnvironment(prisma14, "legacy", suffix);
  return {
    organizationId: legacy.organization.id,
    projectId: legacy.project.id,
    runtimeEnvironmentId: legacy.environment.id,
    environmentId: legacy.environment.id,
  };
}

function buildCreateRunInput(params: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
  idempotencyKey: string;
  taskIdentifier: string;
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
      idempotencyKey: params.idempotencyKey,
      idempotencyKeyExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      taskIdentifier: params.taskIdentifier,
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
      depth: 1, // a child run (has a parent)
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

function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = new PostgresRunStore({
    prisma: prisma14,
    readOnlyPrisma: prisma14,
    schemaVariant: "legacy",
  });
  const newStore = new PostgresRunStore({
    prisma: prisma17 as never,
    readOnlyPrisma: prisma17 as never,
    schemaVariant: "dedicated",
  });
  return { router: new RoutingRunStore({ new: newStore, legacy: legacyStore }) };
}

// A faithful port of resolveIdempotencyDedupClient's parent-residency branch: the dedup client is the
// parent's own DB writer. This is the exact routing decision the code makes.
function resolveDedupClient(
  parentResidency: Residency,
  newClient: PrismaClientOrTransaction,
  legacyClient: PrismaClientOrTransaction
): PrismaClientOrTransaction {
  return parentResidency === "NEW" ? newClient : legacyClient;
}

describe("run-ops split — GLOBAL-scope idempotency dedup across two different-residency parents", () => {
  // The real trigger dedup flow for one trigger with an idempotency key, minus the webapp glue:
  //   1. resolve the dedup client by the PARENT's residency,
  //   2. probe runStore.findRun({ env, idempotencyKey, task }, { include }, dedupClient) — the EXACT
  //      id-less probe the trigger hot path issues,
  //   3. if a run comes back → CACHED hit, mint nothing,
  //   4. else createRun a fresh child on the store its (parent-inherited) id-shape names.
  // A child inherits its parent's residency, so a NEW parent's child gets a run-ops id (→ #new) and a
  // LEGACY parent's child gets a cuid (→ #legacy).
  async function triggerChild(
    router: RoutingRunStore,
    params: {
      parentResidency: Residency;
      childId: string;
      childFriendlyId: string;
      idempotencyKey: string;
      taskIdentifier: string;
      env: {
        organizationId: string;
        projectId: string;
        runtimeEnvironmentId: string;
        environmentId: string;
      };
      newClient: PrismaClientOrTransaction;
      legacyClient: PrismaClientOrTransaction;
    }
  ): Promise<{ cached: boolean; runId: string }> {
    const dedupClient = resolveDedupClient(
      params.parentResidency,
      params.newClient,
      params.legacyClient
    );

    const existing = (await router.findRun(
      {
        runtimeEnvironmentId: params.env.runtimeEnvironmentId,
        idempotencyKey: params.idempotencyKey,
        taskIdentifier: params.taskIdentifier,
      },
      { include: { associatedWaitpoint: true } },
      dedupClient
    )) as Record<string, any> | null;

    if (existing) {
      return { cached: true, runId: existing.id as string };
    }

    await router.createRun(
      buildCreateRunInput({
        runId: params.childId,
        friendlyId: params.childFriendlyId,
        organizationId: params.env.organizationId,
        projectId: params.env.projectId,
        runtimeEnvironmentId: params.env.runtimeEnvironmentId,
        idempotencyKey: params.idempotencyKey,
        taskIdentifier: params.taskIdentifier,
      })
    );
    return { cached: false, runId: params.childId };
  }

  async function countChildrenForKey(
    prisma14: PrismaClient,
    prisma17: RunOpsPrismaClient,
    environmentId: string,
    idempotencyKey: string,
    taskIdentifier: string
  ): Promise<{ legacy: number; new: number; total: number }> {
    const where = {
      runtimeEnvironmentId: environmentId,
      idempotencyKey,
      taskIdentifier,
    };
    const legacy = await prisma14.taskRun.count({ where });
    const nw = await prisma17.taskRun.count({ where });
    return { legacy, new: nw, total: legacy + nw };
  }

  // (a) NEW parent triggers first, then LEGACY parent — same GLOBAL key. If the LEGACY parent's probe
  // only read the LEGACY DB it would miss the NEW child and mint a second one → two children.
  heteroRunOpsPostgresTest(
    "NEW-parent-first then LEGACY-parent: one global key must yield exactly one child",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "gsx_a");
      const idempotencyKey = "global-scope-key-a";
      const taskIdentifier = "child-task";

      // Trigger 1: from a NEW-resident parent → child born on #new (run-ops id).
      const first = await triggerChild(router, {
        parentResidency: "NEW",
        childId: runOpsNew("gxan"),
        childFriendlyId: "run_gsx_a_new_child",
        idempotencyKey,
        taskIdentifier,
        env,
        newClient: prisma17 as unknown as PrismaClientOrTransaction,
        legacyClient: prisma14,
      });
      expect(first.cached).toBe(false);

      // Trigger 2: from a LEGACY-resident parent → child would be born on #legacy (cuid) UNLESS the
      // dedup probe sees trigger 1's child on #new and returns it cached.
      const second = await triggerChild(router, {
        parentResidency: "LEGACY",
        childId: cuidLegacy("gxal"),
        childFriendlyId: "run_gsx_a_legacy_child",
        idempotencyKey,
        taskIdentifier,
        env,
        newClient: prisma17 as unknown as PrismaClientOrTransaction,
        legacyClient: prisma14,
      });

      const counts = await countChildrenForKey(
        prisma14,
        prisma17,
        env.environmentId,
        idempotencyKey,
        taskIdentifier
      );

      // The load-bearing assertion: a GLOBAL idempotency key must map to exactly ONE child run,
      // no matter that the two parents live on different physical DBs.
      expect(counts.total).toBe(1);
      // And the second trigger must be a cached hit resolving to the FIRST child.
      expect(second.cached).toBe(true);
      expect(second.runId).toBe(first.runId);
    }
  );

  // (b) Reverse order: LEGACY parent first, then NEW parent. Symmetric — guards the other fan-out leg.
  heteroRunOpsPostgresTest(
    "LEGACY-parent-first then NEW-parent: one global key must yield exactly one child",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedSharedEnv(prisma14, "gsx_b");
      const idempotencyKey = "global-scope-key-b";
      const taskIdentifier = "child-task";

      const first = await triggerChild(router, {
        parentResidency: "LEGACY",
        childId: cuidLegacy("gxbl"),
        childFriendlyId: "run_gsx_b_legacy_child",
        idempotencyKey,
        taskIdentifier,
        env,
        newClient: prisma17 as unknown as PrismaClientOrTransaction,
        legacyClient: prisma14,
      });
      expect(first.cached).toBe(false);

      const second = await triggerChild(router, {
        parentResidency: "NEW",
        childId: runOpsNew("gxbn"),
        childFriendlyId: "run_gsx_b_new_child",
        idempotencyKey,
        taskIdentifier,
        env,
        newClient: prisma17 as unknown as PrismaClientOrTransaction,
        legacyClient: prisma14,
      });

      const counts = await countChildrenForKey(
        prisma14,
        prisma17,
        env.environmentId,
        idempotencyKey,
        taskIdentifier
      );

      expect(counts.total).toBe(1);
      expect(second.cached).toBe(true);
      expect(second.runId).toBe(first.runId);
    }
  );
});

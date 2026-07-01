// DOCUMENTS the bounded concurrent-flip-window cross-DB idempotency
// duplicate. This is a known, bounded (<=mintCache TTL, 30s default) edge, NOT a closed gap.
//
// During the flip window, two CONCURRENT same-(env, idempotencyKey, taskIdentifier) ROOT triggers can
// land on instances with DIVERGENT cached mint-kinds: the stale instance mints a cuid run on #legacy,
// the flipped instance a ksuid run on #new. The dedup probe (probe-before-mint) only catches an
// ALREADY-COMMITTED run; two truly-simultaneous mints both miss, then both create. The per-DB unique
// constraint on (runtimeEnvironmentId, idempotencyKey, taskIdentifier) is PER PHYSICAL DB, so it
// cannot reject the second insert that lands on the OTHER DB. This test proves both creates SUCCEED
// (the duplicate is real) and the NEW-first read fan-out collapses subsequent reads to one run
// (the duplicate is bounded — see the cross-DB dedup tie-break test). A cross-DB write guard is
// intentionally not added here; that is a deliberate policy decision left to the operator.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type { CreateRunInput, RunStoreSchemaVariant } from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id length (no internal underscore): 25 -> cuid -> LEGACY,
// 27 -> ksuid -> NEW.
const cuidLegacy = (seed: string) => (seed + "c".repeat(25)).slice(0, 25);
const ksuidNew = (seed: string) => (seed + "k".repeat(27)).slice(0, 27);

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
  return new RoutingRunStore({ new: newStore, legacy: legacyStore });
}

describe("RoutingRunStore — mint-on-flip bounded concurrent-window cross-DB duplicate (DOCUMENTED, not guarded)", () => {
  heteroRunOpsPostgresTest(
    "two divergent-cache root mints of the SAME (env, key) BOTH succeed, landing one-per-DB (per-DB unique cannot catch it)",
    async ({ prisma14, prisma17 }) => {
      const router = makeSplitRouter(prisma14, prisma17);
      // One logical environment shared across both physical DBs (same scalar envId on each).
      const seed = await seedEnvironment(prisma14, "legacy", "flipwin");
      const environmentId = seed.environment.id;
      const idempotencyKey = "flip-window-key";
      const taskIdentifier = "my-task";

      const staleCuidRunId = cuidLegacy("rfl"); // stale instance mints cuid -> #legacy
      const flippedKsuidRunId = ksuidNew("rfn"); // flipped instance mints ksuid -> #new

      // Both concurrent mints commit. The second does NOT throw a unique violation: the constraint is
      // PER-DB and these land on different physical DBs.
      await router.createRun(
        buildCreateRunInput({
          runId: staleCuidRunId,
          friendlyId: "run_flip_legacy",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: environmentId,
          idempotencyKey,
          taskIdentifier,
        })
      );
      await router.createRun(
        buildCreateRunInput({
          runId: flippedKsuidRunId,
          friendlyId: "run_flip_new",
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: environmentId,
          idempotencyKey,
          taskIdentifier,
        })
      );

      // The duplicate is REAL: a row for the same key physically exists on BOTH DBs.
      expect(await prisma14.taskRun.findFirst({ where: { id: staleCuidRunId } })).not.toBeNull();
      expect(await prisma17.taskRun.findFirst({ where: { id: flippedKsuidRunId } })).not.toBeNull();

      // The duplicate is BOUNDED: subsequent reads via the id-less probe collapse to exactly ONE run,
      // deterministically the NEW one (NEW-first fan-out) — the same tie-break the cross-DB dedup
      // read locks. So at most one of the two divergent mints is observable after the window closes.
      const found = (await router.findRun({
        runtimeEnvironmentId: environmentId,
        idempotencyKey,
        taskIdentifier,
      })) as Record<string, any> | null;
      expect(found).not.toBeNull();
      expect(found!.id).toBe(flippedKsuidRunId);
    }
  );
});

// Idempotency cross-DB dedup LOCK against the REAL two-physical-DB split.
//
// The trigger hot path dedupes before minting via the id-less probe
// `runStore.findRun({ runtimeEnvironmentId, idempotencyKey, taskIdentifier },
// { include: { associatedWaitpoint: true } }, dedupClient)`
// (apps/webapp/app/runEngine/concerns/idempotencyKeys.server.ts). The existing run may live
// on EITHER physical DB (a cuid run on #legacy minted before the org flipped to run-ops id; a run-ops run on
// #new after). The PG unique key is PER-DB and cannot enforce cross-DB uniqueness, so dedup must be
// correct at the routing layer. RoutingRunStore.findRun drops the caller
// dedupClient and, for an id-less where, fans out NEW→LEGACY (#findRunUnrouted).
// Highest risk: `associatedWaitpoint` hydration — the scalar-only #new store strips the relation and
// rehydrates from Waitpoint.completedByTaskRunId, whereas #legacy uses the Prisma include; the andWait
// idempotent hit reads existingRun.associatedWaitpoint.

import { heteroRunOpsPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RoutingRunStore } from "./runOpsStore.js";
import type {
  CreateRunInput,
  RunAssociatedWaitpointInput,
  RunStoreSchemaVariant,
} from "./types.js";

type AnyClient = PrismaClient | RunOpsPrismaClient;

// ownerEngine classifies by internal-id LENGTH after stripping a single leading `<prefix>_`:
// 25 chars → cuid → LEGACY, a v1 body (version "1" at index 25) → run-ops id → NEW. So a classifiable id
// must carry NO internal underscore. These mint a distinct id of the right length from a short seed.
function cuidLegacy(seed: string): string {
  return (seed + "c".repeat(25)).slice(0, 25); // 25 chars, no underscore → LEGACY
}
function runOpsNew(seed: string): string {
  return (seed.replace(/[^0-9a-v]/g, "0") + "k".repeat(24)).slice(0, 24) + "01";
}

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
    idempotencyKey: `wpidem_${params.id}`,
    userProvidedIdempotencyKey: false,
    projectId: params.projectId,
    environmentId: params.environmentId,
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
    associatedWaitpoint: params.associatedWaitpoint,
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
// prisma14. Two physically-distinct DBs, dedicated schema on #new.
function makeSplitRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyStore = makeLegacyStore(prisma14);
  const newStore = makeDedicatedStore(prisma17);
  return {
    router: new RoutingRunStore({ new: newStore, legacy: legacyStore }),
    legacyStore,
    newStore,
  };
}

// The EXACT dedup probe the trigger hot path issues: id-less
// where keyed on (runtimeEnvironmentId, idempotencyKey, taskIdentifier), include associatedWaitpoint.
function dedupProbe(
  router: RoutingRunStore,
  params: { runtimeEnvironmentId: string; idempotencyKey: string; taskIdentifier: string }
) {
  return router.findRun(
    {
      runtimeEnvironmentId: params.runtimeEnvironmentId,
      idempotencyKey: params.idempotencyKey,
      taskIdentifier: params.taskIdentifier,
    },
    { include: { associatedWaitpoint: true } }
  );
}

describe("RoutingRunStore — cross-DB idempotency dedup probe", () => {
  // the matching run + its associated waitpoint live on #legacy (cuid, full schema). The
  // probe fans out NEW (miss) → LEGACY (hit) and must hydrate the waitpoint via the legacy include.
  heteroRunOpsPostgresTest(
    "a cuid run on #legacy is found by the id-less probe with associatedWaitpoint hydrated",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "cg2_a");
      const runId = cuidLegacy("ral"); // 25 chars → LEGACY home
      const waitpointId = cuidLegacy("wal");
      const idempotencyKey = "cg2-key-a";
      const taskIdentifier = "my-task";

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `run_friendly_cg2_a`,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
          idempotencyKey,
          taskIdentifier,
          associatedWaitpoint: buildAssociatedWaitpoint({
            id: waitpointId,
            friendlyId: `waitpoint_cg2_a`,
            projectId: env.project.id,
            environmentId: env.environment.id,
          }),
        })
      );

      // It must NOT have landed on #new (the cuid id routes to LEGACY).
      expect(await prisma17.taskRun.findFirst({ where: { id: runId } })).toBeNull();
      expect(await prisma14.taskRun.findFirst({ where: { id: runId } })).not.toBeNull();

      const found = (await dedupProbe(router, {
        runtimeEnvironmentId: env.environment.id,
        idempotencyKey,
        taskIdentifier,
      })) as Record<string, any> | null;

      expect(found).not.toBeNull();
      expect(found!.id).toBe(runId);
      expect(found!.idempotencyKey).toBe(idempotencyKey);
      // The load-bearing assertion: the andWait idempotent hit reads existingRun.associatedWaitpoint.
      expect(found!.associatedWaitpoint).not.toBeNull();
      expect(found!.associatedWaitpoint.id).toBe(waitpointId);
      expect(found!.associatedWaitpoint.type).toBe("RUN");
      expect(found!.associatedWaitpoint.completedByTaskRunId).toBe(runId);
    }
  );

  // the matching run + its associated waitpoint live on #new (run-ops id, dedicated subset). The
  // probe hits the NEW leg first; the SCALAR-ONLY store must strip the `associatedWaitpoint` relation
  // and re-hydrate it from `Waitpoint.completedByTaskRunId`.
  heteroRunOpsPostgresTest(
    "a run-ops run on #new is found by the id-less probe with associatedWaitpoint hydrated from scalar",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "cg2_b");
      const runId = runOpsNew("rbn"); // v1 body → NEW home
      const waitpointId = runOpsNew("wbn");
      const idempotencyKey = "cg2-key-b";
      const taskIdentifier = "my-task";

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `run_friendly_cg2_b`,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
          idempotencyKey,
          taskIdentifier,
          associatedWaitpoint: buildAssociatedWaitpoint({
            id: waitpointId,
            friendlyId: `waitpoint_cg2_b`,
            projectId: env.project.id,
            environmentId: env.environment.id,
          }),
        })
      );

      // It must NOT have landed on #legacy (the run-ops id routes to NEW).
      expect(await prisma14.taskRun.findFirst({ where: { id: runId } })).toBeNull();
      expect(await prisma17.taskRun.findFirst({ where: { id: runId } })).not.toBeNull();

      const found = (await dedupProbe(router, {
        runtimeEnvironmentId: env.environment.id,
        idempotencyKey,
        taskIdentifier,
      })) as Record<string, any> | null;

      expect(found).not.toBeNull();
      expect(found!.id).toBe(runId);
      expect(found!.idempotencyKey).toBe(idempotencyKey);
      expect(found!.associatedWaitpoint).not.toBeNull();
      expect(found!.associatedWaitpoint.id).toBe(waitpointId);
      expect(found!.associatedWaitpoint.type).toBe("RUN");
      expect(found!.associatedWaitpoint.completedByTaskRunId).toBe(runId);
    }
  );

  // duplicate-guard contract: a run with the SAME (env, idempotencyKey, taskIdentifier)
  // exists on BOTH DBs. The per-DB unique constraint allows one row each (it cannot enforce cross-DB
  // uniqueness); the probe MUST still resolve to exactly ONE run, deterministically the NEW (run-ops id)
  // one per #findRunUnrouted (NEW-first). The duplicate itself is prevented upstream by
  // probe-before-mint plus the per-DB unique constraint; this locks the read tie-break contract.
  heteroRunOpsPostgresTest(
    "the same (env, key) on BOTH DBs resolves deterministically to the NEW run",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      // ONE logical environment id shared by both DBs (the run-ops envId is the same scalar on each).
      const legacySeed = await seedEnvironment(prisma14, "legacy", "cg2_c");
      const environmentId = legacySeed.environment.id;
      const idempotencyKey = "cg2-key-c";
      const taskIdentifier = "my-task";

      const legacyRunId = cuidLegacy("rcl"); // cuid → LEGACY
      const newRunId = runOpsNew("rcn"); // run-ops id → NEW
      const legacyWaitpointId = cuidLegacy("wcl");
      const newWaitpointId = runOpsNew("wcn");

      await router.createRun(
        buildCreateRunInput({
          runId: legacyRunId,
          friendlyId: `run_friendly_cg2_c_l`,
          organizationId: legacySeed.organization.id,
          projectId: legacySeed.project.id,
          runtimeEnvironmentId: environmentId,
          idempotencyKey,
          taskIdentifier,
          associatedWaitpoint: buildAssociatedWaitpoint({
            id: legacyWaitpointId,
            friendlyId: `waitpoint_cg2_c_l`,
            projectId: legacySeed.project.id,
            environmentId,
          }),
        })
      );
      await router.createRun(
        buildCreateRunInput({
          // #new is the dedicated subset (FK-free scalar ids), so the same environmentId scalar is
          // valid there with no owning rows needed.
          runId: newRunId,
          friendlyId: `run_friendly_cg2_c_n`,
          organizationId: legacySeed.organization.id,
          projectId: legacySeed.project.id,
          runtimeEnvironmentId: environmentId,
          idempotencyKey,
          taskIdentifier,
          associatedWaitpoint: buildAssociatedWaitpoint({
            id: newWaitpointId,
            friendlyId: `waitpoint_cg2_c_n`,
            projectId: legacySeed.project.id,
            environmentId,
          }),
        })
      );

      // Sanity: both physical DBs really do carry a row for this key.
      expect(await prisma14.taskRun.findFirst({ where: { id: legacyRunId } })).not.toBeNull();
      expect(await prisma17.taskRun.findFirst({ where: { id: newRunId } })).not.toBeNull();

      const found = (await dedupProbe(router, {
        runtimeEnvironmentId: environmentId,
        idempotencyKey,
        taskIdentifier,
      })) as Record<string, any> | null;

      // Exactly ONE run, deterministically the NEW one (NEW-first fan-out), with its
      // own DB's associated waitpoint hydrated.
      expect(found).not.toBeNull();
      expect(found!.id).toBe(newRunId);
      expect(found!.associatedWaitpoint).not.toBeNull();
      expect(found!.associatedWaitpoint.id).toBe(newWaitpointId);
    }
  );

  // Negative: no row on either DB → null (so the trigger path proceeds to mint a fresh run).
  heteroRunOpsPostgresTest(
    "miss: an unknown (env, key) returns null from the cross-DB probe",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "cg2_miss");

      const found = await dedupProbe(router, {
        runtimeEnvironmentId: env.environment.id,
        idempotencyKey: "cg2-key-does-not-exist",
        taskIdentifier: "my-task",
      });

      expect(found).toBeNull();
    }
  );

  // Standalone idempotent hit (no associatedWaitpoint): the include key must still be PRESENT in the
  // result and be null, on BOTH DB homes — the andWait path lazily creates the waitpoint when this is
  // falsy, so a MISSING key (undefined) vs null must not differ.
  heteroRunOpsPostgresTest(
    "standalone: a run with no associatedWaitpoint hydrates the include key as null on #new",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma17, "dedicated", "cg2_sa_n");
      const runId = runOpsNew("rsan"); // run-ops id → NEW
      const idempotencyKey = "cg2-key-sa-n";

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `run_friendly_cg2_sa_n`,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
          idempotencyKey,
          taskIdentifier: "my-task",
          // no associatedWaitpoint
        })
      );

      const found = (await dedupProbe(router, {
        runtimeEnvironmentId: env.environment.id,
        idempotencyKey,
        taskIdentifier: "my-task",
      })) as Record<string, any> | null;

      expect(found).not.toBeNull();
      expect(found!.id).toBe(runId);
      expect("associatedWaitpoint" in found!).toBe(true);
      expect(found!.associatedWaitpoint).toBeNull();
    }
  );

  heteroRunOpsPostgresTest(
    "standalone: a run with no associatedWaitpoint hydrates the include key as null on #legacy",
    async ({ prisma14, prisma17 }) => {
      const { router } = makeSplitRouter(prisma14, prisma17);
      const env = await seedEnvironment(prisma14, "legacy", "cg2_sa_l");
      const runId = cuidLegacy("rsal"); // cuid → LEGACY
      const idempotencyKey = "cg2-key-sa-l";

      await router.createRun(
        buildCreateRunInput({
          runId,
          friendlyId: `run_friendly_cg2_sa_l`,
          organizationId: env.organization.id,
          projectId: env.project.id,
          runtimeEnvironmentId: env.environment.id,
          idempotencyKey,
          taskIdentifier: "my-task",
        })
      );

      const found = (await dedupProbe(router, {
        runtimeEnvironmentId: env.environment.id,
        idempotencyKey,
        taskIdentifier: "my-task",
      })) as Record<string, any> | null;

      expect(found).not.toBeNull();
      expect(found!.id).toBe(runId);
      expect("associatedWaitpoint" in found!).toBe(true);
      expect(found!.associatedWaitpoint).toBeNull();
    }
  );
});

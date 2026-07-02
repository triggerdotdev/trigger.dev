import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

// Stub `~/db.server` so the `runStore` singleton doesn't eagerly connect at
// import. The concern passes its constructor `prisma` arg as the explicit
// client/tx to every store call, so the singleton's bound handles are never
// exercised — the passed client runs the query. Mirrors the shipped
// `mollifierClaimResolution` test: env-wiring mock only; the DB under test is
// the real PG14 + PG17 hetero-fixture containers.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
}));
// Keep split off so resolveIdempotencyDedupClient returns this.prisma (the hetero fixture client).
vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import type { TriggerTaskRequest } from "~/runEngine/types";

vi.setConfig({ testTimeout: 60_000 });

// The constructor `prisma` arg is the client the four store sites execute
// against. With the run-ops split off (mocked above) the dedup resolver is a
// pass-through that returns this same client, so constructing with the PG14 or
// PG17 fixture client decides which DB the residency-routed dedup probe reads.
function makeConcern(client: PrismaClient) {
  return new IdempotencyKeyConcern(
    client as never,
    {} as never, // engine — unused on the reuse / clear paths
    {} as never // traceEventConcern — unused on the reuse / clear paths
  );
}

function makeRequest(opts: {
  environmentId: string;
  organizationId: string;
  projectId: string;
  taskId: string;
  idempotencyKey: string;
}): TriggerTaskRequest {
  return {
    taskId: opts.taskId,
    environment: {
      id: opts.environmentId,
      organizationId: opts.organizationId,
      projectId: opts.projectId,
      // Leave the org mollifier flag unset so the pre-gate claim path is
      // skipped — this test exercises the PG existing-run lookup + clear,
      // not the Redis claim. (resolveOrgMollifierFlag returns falsy for an
      // org with no mollifier flag, so claimEligible is false.)
      organization: { featureFlags: {} },
    },
    options: {},
    body: { options: { idempotencyKey: opts.idempotencyKey } },
  } as unknown as TriggerTaskRequest;
}

async function seedOrgProjectEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `test-${suffix}`, slug: `test-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `test-${suffix}`,
      slug: `test-${suffix}`,
      organizationId: organization.id,
      externalRef: `test-${suffix}`,
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `test-${suffix}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `test-${suffix}`,
      pkApiKey: `test-${suffix}`,
      shortcode: `test-${suffix}`,
    },
  });
  return { organization, project, runtimeEnvironment };
}

async function seedRun(
  prisma: PrismaClient,
  args: {
    runtimeEnvironmentId: string;
    projectId: string;
    organizationId: string;
    taskIdentifier: string;
    idempotencyKey: string;
    status?: "PENDING" | "EXECUTING" | "COMPLETED_SUCCESSFULLY" | "COMPLETED_WITH_ERRORS";
    idempotencyKeyExpiresAt?: Date;
  }
) {
  const runId = generateKsuidId();
  return prisma.taskRun.create({
    data: {
      id: runId,
      friendlyId: `run_${runId}`,
      taskIdentifier: args.taskIdentifier,
      idempotencyKey: args.idempotencyKey,
      idempotencyKeyExpiresAt: args.idempotencyKeyExpiresAt ?? null,
      status: args.status ?? "EXECUTING",
      payload: JSON.stringify({ foo: "bar" }),
      payloadType: "application/json",
      traceId: "1234",
      spanId: "1234",
      queue: "test",
      runtimeEnvironmentId: args.runtimeEnvironmentId,
      projectId: args.projectId,
      organizationId: args.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

describe("IdempotencyKeyConcern · residency-routed dedup (cross-DB)", () => {
  heteroPostgresTest(
    "resolves a legacy-resident key against the legacy DB; a key whose run lives on the new DB is resolved against the new DB",
    async ({ prisma14, prisma17 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "legacy-auth"
      );

      // Seed the same org/project/env shape on the NEW (PG17) DB so we can
      // place a row there for a *different* key — proving the legacy-pinned
      // read does not see it.
      const newSide = await seedOrgProjectEnv(prisma17, "new-side");

      const reusedKey = "idem-reuse-1";

      // The authoritative existing run lives on the LEGACY (PG14) DB.
      const legacyRun = await seedRun(prisma14, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: reusedKey,
        status: "EXECUTING",
      });

      // A row for a DIFFERENT key lives only on the NEW (PG17) DB.
      const newOnlyKey = "idem-new-only";
      await seedRun(prisma17, {
        runtimeEnvironmentId: newSide.runtimeEnvironment.id,
        projectId: newSide.project.id,
        organizationId: newSide.organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: newOnlyKey,
        status: "EXECUTING",
      });

      const concern = makeConcern(prisma14);

      // (1) Reuse with the legacy key resolves the legacy-seeded run.
      const reuse = await concern.handleTriggerRequest(
        makeRequest({
          environmentId: runtimeEnvironment.id,
          organizationId: organization.id,
          projectId: project.id,
          taskId: "my-task",
          idempotencyKey: reusedKey,
        }),
        undefined
      );
      expect(reuse.isCached).toBe(true);
      if (reuse.isCached === true) {
        expect(reuse.run.id).toBe(legacyRun.id);
      }

      // Exactly one run matches the key on the legacy DB — no duplicate.
      const legacyMatches = await prisma14.taskRun.count({
        where: {
          runtimeEnvironmentId: runtimeEnvironment.id,
          taskIdentifier: "my-task",
          idempotencyKey: reusedKey,
        },
      });
      expect(legacyMatches).toBe(1);

      // (2) A key whose run lives on the new DB is resolved against the new DB.
      const concernOnNew = makeConcern(prisma17);
      const newSideHit = await concernOnNew.handleTriggerRequest(
        makeRequest({
          environmentId: newSide.runtimeEnvironment.id,
          organizationId: newSide.organization.id,
          projectId: newSide.project.id,
          taskId: "my-task",
          idempotencyKey: newOnlyKey,
        }),
        undefined
      );
      expect(newSideHit.isCached).toBe(true);
      if (newSideHit.isCached === true) {
        expect(newSideHit.run.idempotencyKey).toBe(newOnlyKey);
      }

      // (3) An unknown key on the legacy env does not wrongly return the
      // stale legacy hit for a different key.
      const unknown = await concern.handleTriggerRequest(
        makeRequest({
          environmentId: runtimeEnvironment.id,
          organizationId: organization.id,
          projectId: project.id,
          taskId: "my-task",
          idempotencyKey: "idem-never-seen",
        }),
        undefined
      );
      expect(unknown.isCached).toBe(false);
    }
  );

  heteroPostgresTest(
    "cleared-status reuse clears the key on the legacy (PG14) DB and proceeds with a fresh trigger",
    async ({ prisma14 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "cleared-status"
      );

      const key = "idem-cleared-1";

      // Existing run is in a failed (cleared) status — the concern must
      // clear its key against the legacy authority and return isCached:false.
      const legacyRun = await seedRun(prisma14, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: key,
        status: "COMPLETED_WITH_ERRORS",
      });

      const concern = makeConcern(prisma14);

      const result = await concern.handleTriggerRequest(
        makeRequest({
          environmentId: runtimeEnvironment.id,
          organizationId: organization.id,
          projectId: project.id,
          taskId: "my-task",
          idempotencyKey: key,
        }),
        undefined
      );

      // A fresh trigger proceeds (not cached).
      expect(result.isCached).toBe(false);

      // The clear executed against the legacy (PG14) DB: re-query PG14 and
      // assert the key + its expiry are now null on the seeded run.
      const cleared = await prisma14.taskRun.findFirst({ where: { id: legacyRun.id } });
      expect(cleared?.idempotencyKey).toBeNull();
      expect(cleared?.idempotencyKeyExpiresAt).toBeNull();
    }
  );

  heteroPostgresTest(
    "expired idempotency key is cleared on the legacy (PG14) DB and a fresh trigger proceeds",
    async ({ prisma14 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "expired-key"
      );

      const key = "idem-expired-1";

      const legacyRun = await seedRun(prisma14, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: key,
        status: "EXECUTING",
        idempotencyKeyExpiresAt: new Date(Date.now() - 60_000), // already expired
      });

      const concern = makeConcern(prisma14);

      const result = await concern.handleTriggerRequest(
        makeRequest({
          environmentId: runtimeEnvironment.id,
          organizationId: organization.id,
          projectId: project.id,
          taskId: "my-task",
          idempotencyKey: key,
        }),
        undefined
      );

      expect(result.isCached).toBe(false);

      const cleared = await prisma14.taskRun.findFirst({ where: { id: legacyRun.id } });
      expect(cleared?.idempotencyKey).toBeNull();
      expect(cleared?.idempotencyKeyExpiresAt).toBeNull();
    }
  );
});

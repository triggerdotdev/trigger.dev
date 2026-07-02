import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

// Stub so the runStore singleton doesn't eagerly connect at import.
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

function makeConcern(client: PrismaClient) {
  return new IdempotencyKeyConcern(client as never, {} as never, {} as never);
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
  }
) {
  const runId = generateKsuidId();
  return prisma.taskRun.create({
    data: {
      id: runId,
      friendlyId: `run_${runId}`,
      taskIdentifier: args.taskIdentifier,
      idempotencyKey: args.idempotencyKey,
      idempotencyKeyExpiresAt: null,
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
    "a would-be-new run resolves its key against the new (PG17) DB, not the legacy (PG14) DB",
    async ({ prisma14, prisma17 }) => {
      // Same env shape on both DBs.
      const legacy = await seedOrgProjectEnv(prisma14, "resid-legacy");
      const next = await seedOrgProjectEnv(prisma17, "resid-new");

      const key = "idem-resid-1";

      const newRun = await seedRun(prisma17, {
        runtimeEnvironmentId: next.runtimeEnvironment.id,
        projectId: next.project.id,
        organizationId: next.organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: key,
        status: "EXECUTING",
      });

      const concernOnNew = makeConcern(prisma17);
      const hit = await concernOnNew.handleTriggerRequest(
        makeRequest({
          environmentId: next.runtimeEnvironment.id,
          organizationId: next.organization.id,
          projectId: next.project.id,
          taskId: "my-task",
          idempotencyKey: key,
        }),
        undefined
      );
      expect(hit.isCached).toBe(true);
      if (hit.isCached === true) {
        expect(hit.run.id).toBe(newRun.id);
      }

      // The legacy DB holds no row for this key — a legacy-pinned probe would miss it.
      const legacyMatches = await prisma14.taskRun.count({
        where: {
          runtimeEnvironmentId: legacy.runtimeEnvironment.id,
          taskIdentifier: "my-task",
          idempotencyKey: key,
        },
      });
      expect(legacyMatches).toBe(0);
    }
  );

  heteroPostgresTest(
    "a would-be-legacy run still resolves its key against the legacy (PG14) DB",
    async ({ prisma14 }) => {
      const legacy = await seedOrgProjectEnv(prisma14, "resid-legacy-only");
      const key = "idem-resid-legacy";

      const legacyRun = await seedRun(prisma14, {
        runtimeEnvironmentId: legacy.runtimeEnvironment.id,
        projectId: legacy.project.id,
        organizationId: legacy.organization.id,
        taskIdentifier: "my-task",
        idempotencyKey: key,
        status: "EXECUTING",
      });

      const concernOnLegacy = makeConcern(prisma14);
      const hit = await concernOnLegacy.handleTriggerRequest(
        makeRequest({
          environmentId: legacy.runtimeEnvironment.id,
          organizationId: legacy.organization.id,
          projectId: legacy.project.id,
          taskId: "my-task",
          idempotencyKey: key,
        }),
        undefined
      );
      expect(hit.isCached).toBe(true);
      if (hit.isCached === true) {
        expect(hit.run.id).toBe(legacyRun.id);
      }
    }
  );
});

import { heteroPostgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateKsuidId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

// Stub these so the default singletons don't eagerly connect at import. The
// reset service passes its `_prisma` arg as the explicit tx to every store
// call, so the singleton handles are never exercised — the passed PG14 client
// runs the query. The DB under test is the real PG14 + PG17 hetero fixture.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/v3/runEngine.server", () => ({ engine: {} }));

// With `getMollifierBuffer()` returning null the PG clear path runs cleanly
// (no Redis surface). The buffer path is out of scope for this unit.
const bufferMock: { current: unknown } = { current: null };
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => bufferMock.current,
}));

import { PostgresRunStore } from "@internal/run-store";
import { ResetIdempotencyKeyService } from "~/v3/services/resetIdempotencyKey.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

vi.setConfig({ testTimeout: 60_000 });

function makeService(legacyPrisma: PrismaClient) {
  const legacyStore = new PostgresRunStore({
    prisma: legacyPrisma,
    readOnlyPrisma: legacyPrisma,
  });
  return new ResetIdempotencyKeyService(legacyPrisma as never, legacyPrisma as never, legacyStore);
}

function makeEnv(opts: { id: string; organizationId: string }): AuthenticatedEnvironment {
  return {
    id: opts.id,
    organizationId: opts.organizationId,
  } as unknown as AuthenticatedEnvironment;
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

describe("ResetIdempotencyKeyService · legacy-authority pin (cross-DB)", () => {
  heteroPostgresTest(
    "clears the key on the legacy (PG14) authority only; a PG17-only same-key row is untouched, and reuse-after-reset finds no row",
    async ({ prisma14, prisma17 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "reset-legacy"
      );
      const newSide = await seedOrgProjectEnv(prisma17, "reset-new-side");

      const key = "idem-reset-1";
      const taskIdentifier = "my-task";

      const legacyRun = await seedRun(prisma14, {
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        taskIdentifier,
        idempotencyKey: key,
        status: "EXECUTING",
        idempotencyKeyExpiresAt: new Date(Date.now() + 60_000),
      });

      // Same (task, key) tuple planted ONLY on PG17 — a legacy-pinned reset
      // must not leak to it.
      const newRun = await seedRun(prisma17, {
        runtimeEnvironmentId: newSide.runtimeEnvironment.id,
        projectId: newSide.project.id,
        organizationId: newSide.organization.id,
        taskIdentifier,
        idempotencyKey: key,
        status: "EXECUTING",
        idempotencyKeyExpiresAt: new Date(Date.now() + 60_000),
      });

      const service = makeService(prisma14);

      const result = await service.call(
        key,
        taskIdentifier,
        makeEnv({ id: runtimeEnvironment.id, organizationId: organization.id })
      );

      expect(result).toEqual({ id: key });

      // Cleared on legacy; run otherwise intact (not deleted).
      const clearedLegacy = await prisma14.taskRun.findFirst({ where: { id: legacyRun.id } });
      expect(clearedLegacy).not.toBeNull();
      expect(clearedLegacy?.idempotencyKey).toBeNull();
      expect(clearedLegacy?.idempotencyKeyExpiresAt).toBeNull();
      expect(clearedLegacy?.id).toBe(legacyRun.id);
      expect(clearedLegacy?.status).toBe("EXECUTING");

      // PG17-only row untouched — no leak to the wrong DB.
      const untouchedNew = await prisma17.taskRun.findFirst({ where: { id: newRun.id } });
      expect(untouchedNew?.idempotencyKey).toBe(key);
      expect(untouchedNew?.idempotencyKeyExpiresAt).not.toBeNull();

      // Reuse-after-reset: no row resolves on legacy → a fresh run would mint.
      const reusable = await prisma14.taskRun.findFirst({
        where: {
          runtimeEnvironmentId: runtimeEnvironment.id,
          taskIdentifier,
          idempotencyKey: key,
        },
      });
      expect(reusable).toBeNull();
    }
  );

  heteroPostgresTest(
    "handoff re-check (totalCount === 0 branch) clears a row that materialises on the legacy (PG14) authority after the initial clear",
    async ({ prisma14 }) => {
      const { project, organization, runtimeEnvironment } = await seedOrgProjectEnv(
        prisma14,
        "reset-handoff"
      );

      const key = "idem-handoff-1";
      const taskIdentifier = "my-task";

      // Model the PG↔buffer race: initial clear sees no row (count 0), buffer
      // reports no cleared run (totalCount 0), then the run materialises on
      // legacy mid-call (drainer's engine.trigger) before the handoff re-check.
      bufferMock.current = {
        resetIdempotency: vi.fn(async () => {
          await seedRun(prisma14, {
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            taskIdentifier,
            idempotencyKey: key,
            status: "EXECUTING",
          });
          return { clearedRunId: null as string | null };
        }),
      };

      const service = makeService(prisma14);

      const result = await service.call(
        key,
        taskIdentifier,
        makeEnv({ id: runtimeEnvironment.id, organizationId: organization.id })
      );

      // Handoff re-check cleared the materialised row on legacy → success.
      expect(result).toEqual({ id: key });

      const reusable = await prisma14.taskRun.findFirst({
        where: {
          runtimeEnvironmentId: runtimeEnvironment.id,
          taskIdentifier,
          idempotencyKey: key,
        },
      });
      expect(reusable).toBeNull();

      bufferMock.current = null;
    }
  );
});

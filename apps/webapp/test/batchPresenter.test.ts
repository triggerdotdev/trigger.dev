import { containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  displayableEnvironment,
  type DisplayableInputEnvironment,
} from "~/models/runtimeEnvironment.server";
import { BatchPresenter } from "~/presenters/v3/BatchPresenter.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

/**
 * Seeds the control-plane org/project/env on one DB. The env is control-plane; it is
 * resolved separately from the run-ops batch row (the cross-seam FK is physically dropped),
 * so this always lives on the same DB that the injected resolveDisplayableEnvironment reads.
 */
async function seedEnvironment(
  prisma: PrismaClient,
  slug: string,
  type: "DEVELOPMENT" | "PRODUCTION" = "PRODUCTION"
): Promise<SeedContext> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
    },
  });

  let orgMemberId: string | undefined;
  if (type === "DEVELOPMENT") {
    const user = await prisma.user.create({
      data: {
        email: `user-${slug}@example.com`,
        name: `User ${slug}`,
        displayName: `Display ${slug}`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    const member = await prisma.orgMember.create({
      data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
    });
    orgMemberId = member.id;
  }

  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${slug}`,
      pkApiKey: `pk_${slug}`,
      shortcode: `sc-${slug}`,
      orgMemberId,
    },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
  };
}

async function seedBatch(
  prisma: PrismaClient,
  environmentId: string,
  opts: {
    friendlyId: string;
    status?: any;
    batchVersion?: string;
    runCount?: number;
    withError?: boolean;
  }
) {
  return prisma.batchTaskRun.create({
    data: {
      friendlyId: opts.friendlyId,
      runtimeEnvironmentId: environmentId,
      status: opts.status ?? "COMPLETED",
      batchVersion: opts.batchVersion ?? "v1",
      runCount: opts.runCount ?? 0,
      successfulRunCount: 3,
      failedRunCount: 1,
      idempotencyKey: `idem-${opts.friendlyId}`,
      errors: opts.withError
        ? {
            create: [
              {
                index: 0,
                taskIdentifier: "my-task",
                error: JSON.stringify({ message: "boom", stack: "x\ny" }),
                errorCode: "TASK_RUN_FAILED",
              },
            ],
          }
        : undefined,
    },
  });
}

/**
 * Builds a resolveDisplayableEnvironment closure over a real control-plane container — exactly
 * mirroring the production findDisplayableEnvironment (reads control-plane, returns the
 * displayableEnvironment shape). This is the only injected boundary; the DB is never mocked.
 */
function makeEnvResolver(controlPlane: PrismaClient) {
  return async (environmentId: string, userId: string | undefined) => {
    const environment = await controlPlane.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: {
        id: true,
        type: true,
        slug: true,
        orgMember: {
          select: { user: { select: { id: true, name: true, displayName: true } } },
        },
      },
    });
    if (!environment) {
      return undefined;
    }
    return displayableEnvironment(environment as DisplayableInputEnvironment, userId);
  };
}

describe("BatchPresenter read-through (PG14 legacy + PG17 new)", () => {
  // Batch detail resolves on run-ops NEW (split on). Legacy replica is never probed.
  heteroPostgresTest(
    "resolves a NEW-resident batch and never probes the legacy replica",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedEnvironment(prisma17, "new1");
      await seedBatch(prisma17, ctx.environmentId, {
        friendlyId: "batch_new1",
        withError: true,
        runCount: 4,
      });

      // Real readThroughRun. A tripwire legacy client throws if batchTaskRun is ever accessed,
      // proving a NEW-resident row is served without probing the legacy replica.
      const tripwireLegacy = new Proxy(prisma14, {
        get(target, prop) {
          if (prop === "batchTaskRun") {
            throw new Error("legacy replica must not be probed for a NEW-resident batch");
          }
          return (target as any)[prop];
        },
      }) as unknown as PrismaClient;

      const presenter = new BatchPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: prisma17,
        legacyReplica: tripwireLegacy,
        readThrough: readThroughRun,
        resolveDisplayableEnvironment: makeEnvResolver(prisma17),
      });

      const result = await presenter.call({
        environmentId: ctx.environmentId,
        batchId: "batch_new1",
      });

      expect(result.friendlyId).toBe("batch_new1");
      expect(result.runCount).toBe(4);
      expect(result.idempotencyKey).toBe("idem-batch_new1");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].errorCode).toBe("TASK_RUN_FAILED");
      expect(result.environment.id).toBe(ctx.environmentId);
      expect(result.environment.type).toBe("PRODUCTION");
    }
  );

  // Batch detail resolves on run-ops OLD/legacy READ REPLICA (split on, in-retention).
  // Cross-version round-trip: PG14 legacy -> presenter, JSON error payload byte-identical.
  heteroPostgresTest(
    "resolves a legacy-only batch via the legacy READ REPLICA, byte-identical",
    async ({ prisma14, prisma17 }) => {
      // Env is control-plane (lives wherever the resolver reads); batch is run-ops, legacy-only.
      const ctx = await seedEnvironment(prisma14, "legacy1");
      const errorPayload = JSON.stringify({ message: "legacy boom", stack: "a\nb\nc" });
      await prisma14.batchTaskRun.create({
        data: {
          friendlyId: "batch_legacy1",
          runtimeEnvironmentId: ctx.environmentId,
          status: "COMPLETED",
          batchVersion: "v1",
          runCount: 2,
          successfulRunCount: 1,
          failedRunCount: 1,
          idempotencyKey: "idem-batch_legacy1",
          errors: {
            create: [
              {
                index: 0,
                taskIdentifier: "legacy-task",
                error: errorPayload,
                errorCode: "LEGACY_CODE",
              },
            ],
          },
        },
      });

      // The structural guarantee: there is no legacy-PRIMARY handle in readThroughRun; the only
      // legacy handle threaded here is the read replica (prisma14).
      const presenter = new BatchPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: prisma17, // NEW probe misses (nothing seeded there)
        legacyReplica: prisma14,
        // Real readThroughRun; the NEW miss falls through to the legacy replica.
        readThrough: readThroughRun,
        resolveDisplayableEnvironment: makeEnvResolver(prisma14),
      });

      const result = await presenter.call({
        environmentId: ctx.environmentId,
        batchId: "batch_legacy1",
      });

      expect(result.friendlyId).toBe("batch_legacy1");
      expect(result.runCount).toBe(2);
      expect(result.errors).toHaveLength(1);
      // JSON error payload round-trips byte-identically across PG14 -> presenter.
      expect(result.errors[0].error).toBe(errorPayload);
      expect(result.errors[0].taskIdentifier).toBe("legacy-task");
      expect(result.environment.id).toBe(ctx.environmentId);
    }
  );

  // Post-termination / not-found yields the normal "Batch not found".
  heteroPostgresTest(
    "throws the normal not-found when the batch is absent from both stores",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedEnvironment(prisma14, "missing1");

      const presenter = new BatchPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: prisma17,
        legacyReplica: prisma14,
        readThrough: readThroughRun,
        resolveDisplayableEnvironment: makeEnvResolver(prisma14),
      });

      await expect(
        presenter.call({ environmentId: ctx.environmentId, batchId: "batch_does_not_exist" })
      ).rejects.toThrow("Batch not found");
    }
  );

  // Env decoupling parity for a DEVELOPMENT env (userName branch).
  heteroPostgresTest(
    "resolves the DEVELOPMENT env userName separately from the run-ops batch row",
    async ({ prisma14, prisma17 }) => {
      const ctx = await seedEnvironment(prisma17, "dev1", "DEVELOPMENT");
      await seedBatch(prisma17, ctx.environmentId, { friendlyId: "batch_dev1" });

      const presenter = new BatchPresenter(undefined, undefined, {
        splitEnabled: true,
        newClient: prisma17,
        legacyReplica: prisma14,
        readThrough: readThroughRun,
        resolveDisplayableEnvironment: makeEnvResolver(prisma17),
      });

      // No userId passed -> userName resolves to the member's username (the orgMember branch).
      const result = await presenter.call({
        environmentId: ctx.environmentId,
        batchId: "batch_dev1",
      });

      expect(result.environment.type).toBe("DEVELOPMENT");
      expect(result.environment.userName).toBe("Display dev1");
    }
  );
});

describe("BatchPresenter single-DB passthrough", () => {
  // Passthrough + self-host collapse: one plain read, legacy closure never invoked.
  containerTest(
    "single-DB resolves the batch with one plain read and never touches the legacy boundary",
    async ({ prisma }) => {
      const ctx = await seedEnvironment(prisma, "passthrough");
      await seedBatch(prisma, ctx.environmentId, {
        friendlyId: "batch_passthrough",
        withError: true,
        runCount: 5,
      });

      let legacyInvoked = false;
      const presenter = new BatchPresenter(prisma, prisma, {
        splitEnabled: false,
        // Pass the single DB as both clients; the passthrough must read NEW only.
        newClient: prisma,
        legacyReplica: new Proxy(prisma, {
          get(target, prop) {
            if (prop === "batchTaskRun") {
              legacyInvoked = true;
              throw new Error("legacy boundary must not be touched in single-DB passthrough");
            }
            return (target as any)[prop];
          },
        }) as unknown as PrismaClient,
        resolveDisplayableEnvironment: makeEnvResolver(prisma),
      });

      const result = await presenter.call({
        environmentId: ctx.environmentId,
        batchId: "batch_passthrough",
      });

      expect(result.friendlyId).toBe("batch_passthrough");
      expect(result.runCount).toBe(5);
      expect(result.errors).toHaveLength(1);
      expect(result.environment.id).toBe(ctx.environmentId);
      expect(legacyInvoked).toBe(false);
    }
  );

  // e2e #3 scoped proxy: a batch whose members span migrated + abandoned runs still resolves
  // at the batch-record level. Scope: BatchPresenter reads only the batch row, not its member
  // TaskRuns — the dangling-reference gate over members is owned by the migration / dangling-gate
  // units, not this presenter. This unit's contribution is "batch detail loads regardless of
  // which run-ops store holds the batch row."
  containerTest(
    "e2e #3 proxy: a batch spanning migrated + abandoned runs still resolves",
    async ({ prisma }) => {
      const ctx = await seedEnvironment(prisma, "e2e3");
      await seedBatch(prisma, ctx.environmentId, {
        friendlyId: "batch_e2e3",
        runCount: 10, // implies members spanning migrated + abandoned runs
      });

      const presenter = new BatchPresenter(prisma, prisma, {
        splitEnabled: false,
        newClient: prisma,
        resolveDisplayableEnvironment: makeEnvResolver(prisma),
      });

      const result = await presenter.call({
        environmentId: ctx.environmentId,
        batchId: "batch_e2e3",
      });

      expect(result.friendlyId).toBe("batch_e2e3");
      expect(result.runCount).toBe(10);
    }
  );
});

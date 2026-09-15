// Read-through proof for the public single-run result poll (ApiRunResultPresenter). The presenter
// routes its TaskRun(+attempts) lookup-by-friendlyId through the run store, which selects the owning
// DB by run-id residency (id shape): a run-ops (NEW) id reads the new store, a cuid (LEGACY) id reads
// the legacy store; a missing run → undefined → the route's normal 404; single-DB is one plain
// findFirst. NEVER mock the DB — the cross-version proof uses a heterogeneous legacy+new Postgres
// fixture wired into a RoutingRunStore; only pure boundaries are injected.
import { heteroPostgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { generateRunOpsId } from "@trigger.dev/core/v3/isomorphic";
import { customAlphabet } from "nanoid";
import { describe, expect, vi } from "vitest";
import { ApiRunResultPresenter } from "~/presenters/v3/ApiRunResultPresenter.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";

// Neutralize the db.server singleton so importing the presenter (via BasePresenter) and
// runStore.server (which imports db.server defaults) does not try to connect to the env
// database. Every read in this file goes through the RoutingRunStore we inject explicitly.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

vi.setConfig({ testTimeout: 60_000 });

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

// Wire the presenter's run store to the test containers so run reads route to the container DBs
// (NEW=dedicated, LEGACY=legacy) instead of the default localhost:5432 client. legacyClient may be a
// tripwire proxy to assert a leg is never probed.
function makeRunStore(newClient: PrismaClient, legacyClient: PrismaClient) {
  return new RoutingRunStore({
    new: new PostgresRunStore({
      prisma: newClient as never,
      readOnlyPrisma: newClient as never,
      schemaVariant: "dedicated",
    }),
    legacy: new PostgresRunStore({
      prisma: legacyClient as never,
      readOnlyPrisma: legacyClient as never,
      schemaVariant: "legacy",
    }),
  });
}

// A legacy client whose `taskRun` delegate throws if it is ever accessed — used to prove a
// NEW-resident run is served without probing the legacy store.
function tripwireLegacy(legacy: PrismaClient): PrismaClient {
  return new Proxy(legacy, {
    get(target, prop) {
      if (prop === "taskRun") {
        throw new Error("legacy store must not be probed for a NEW-resident run");
      }
      return (target as any)[prop];
    },
  }) as unknown as PrismaClient;
}

// Residency by friendlyId shape (after stripping `run_`): a valid 26-char v1 body (version "1" at
// index 25, base32hex core) → NEW; a 25-char body → LEGACY (cuid analog). ownerEngine classifies on
// the public friendly id, so newFriendlyId uses the real generator to produce a NEW-classified body.
function newFriendlyId(): string {
  return "run_" + generateRunOpsId();
}
function legacyFriendlyId(): string {
  return "run_" + customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 25)();
}

function authEnv(environmentId: string): AuthenticatedEnvironment {
  // The presenter only reads env.id (the runtimeEnvironmentId filter) and the tracing attrs.
  return {
    id: environmentId,
    project: { id: "p", name: "p" },
    organization: { id: "o", title: "o" },
    orgMember: null,
  } as unknown as AuthenticatedEnvironment;
}

type SeedContext = {
  environmentId: string;
  projectId: string;
  organizationId: string;
  backgroundWorkerId: string;
  backgroundWorkerTaskId: string;
  queueId: string;
};

async function seedEnv(prisma: PrismaClient, slug: string) {
  const user = await prisma.user.create({
    data: { email: `${slug}@test.com`, name: "t", authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: "Org",
      slug: `org-${slug}-${idGenerator()}`,
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  const project = await prisma.project.create({
    data: {
      name: "Proj",
      slug: `proj-${slug}-${idGenerator()}`,
      organizationId: organization.id,
      externalRef: `ext-${slug}-${idGenerator()}`,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `api-${slug}-${idGenerator()}`,
      pkApiKey: `pk-${slug}-${idGenerator()}`,
      shortcode: `sc-${slug}-${idGenerator()}`,
    },
  });
  return { organization, project, environment };
}

async function seedWorker(prisma: PrismaClient, ctx: { environmentId: string; projectId: string }) {
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${idGenerator()}`,
      name: "task/test-task",
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
    },
  });
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${idGenerator()}`,
      contentHash: "hash",
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
      version: "20240101.1",
      metadata: {},
    },
  });
  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${idGenerator()}`,
      slug: "test-task",
      filePath: "src/test.ts",
      exportName: "testTask",
      workerId: worker.id,
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.environmentId,
    },
  });
  return { queueId: queue.id, backgroundWorkerId: worker.id, backgroundWorkerTaskId: task.id };
}

async function fullSeed(prisma: PrismaClient, slug: string): Promise<SeedContext> {
  const { organization, project, environment } = await seedEnv(prisma, slug);
  const worker = await seedWorker(prisma, {
    environmentId: environment.id,
    projectId: project.id,
  });
  return {
    environmentId: environment.id,
    projectId: project.id,
    organizationId: organization.id,
    ...worker,
  };
}

async function seedRunWithAttempt(
  prisma: PrismaClient,
  ctx: SeedContext,
  friendlyId: string,
  opts: {
    status: "COMPLETED_SUCCESSFULLY" | "COMPLETED_WITH_ERRORS" | "CANCELED" | "EXECUTING";
    attempt?: {
      status: "COMPLETED" | "FAILED";
      output?: string;
      outputType?: string;
      error?: unknown;
    };
  }
) {
  const runInternalId = idGenerator();
  const run = await prisma.taskRun.create({
    data: {
      id: runInternalId,
      friendlyId,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: idGenerator(),
      spanId: idGenerator(),
      queue: "task/test-task",
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      status: opts.status,
    },
  });

  if (opts.attempt) {
    await prisma.taskRunAttempt.create({
      data: {
        friendlyId: `attempt_${idGenerator()}`,
        taskRunId: run.id,
        backgroundWorkerId: ctx.backgroundWorkerId,
        backgroundWorkerTaskId: ctx.backgroundWorkerTaskId,
        runtimeEnvironmentId: ctx.environmentId,
        queueId: ctx.queueId,
        status: opts.attempt.status,
        output: opts.attempt.output,
        outputType: opts.attempt.outputType ?? "application/json",
        error: opts.attempt.error as any,
      },
    });
  }

  return run;
}

describe("ApiRunResultPresenter read-through (heterogeneous legacy + new Postgres)", () => {
  heteroPostgresTest(
    "split: a run living on the NEW DB resolves from new and never probes the legacy replica",
    async ({ prisma14, prisma17 }) => {
      const friendlyId = newFriendlyId();
      const ctx = await fullSeed(prisma17 as unknown as PrismaClient, "new-only");
      await seedRunWithAttempt(prisma17 as unknown as PrismaClient, ctx, friendlyId, {
        status: "COMPLETED_SUCCESSFULLY",
        attempt: { status: "COMPLETED", output: '"hello"', outputType: "application/json" },
      });

      // NEW-resident friendlyId routes to the new store; the tripwire legacy throws if its taskRun
      // delegate is ever touched, proving the legacy store is never probed.
      const presenter = new ApiRunResultPresenter(
        undefined,
        undefined,
        undefined,
        makeRunStore(
          prisma17 as unknown as PrismaClient,
          tripwireLegacy(prisma14 as unknown as PrismaClient)
        )
      );

      const result = await presenter.call(friendlyId, authEnv(ctx.environmentId));
      expect(result).toBeDefined();
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.id).toBe(friendlyId);
        expect(result.taskIdentifier).toBe("test-task");
        expect(result.output).toBe('"hello"');
        expect(result.outputType).toBe("application/json");
      }
    }
  );

  // Old legacy-only run resolves from the legacy store (cross-version). A LEGACY-classified id
  // routes directly to the legacy leg, which is backed by the read replica in production.
  heteroPostgresTest(
    "split: an OLD legacy-only run resolves from the legacy read replica across the version boundary",
    async ({ prisma14, prisma17 }) => {
      const friendlyId = legacyFriendlyId();
      // Seed only on legacy. New gets just an env (it is never probed for a LEGACY id).
      const legacyCtx = await fullSeed(prisma14 as unknown as PrismaClient, "legacy-only");
      await fullSeed(prisma17 as unknown as PrismaClient, "new-empty");
      await seedRunWithAttempt(prisma14 as unknown as PrismaClient, legacyCtx, friendlyId, {
        status: "COMPLETED_SUCCESSFULLY",
        attempt: { status: "COMPLETED", output: '"from-legacy"', outputType: "application/json" },
      });

      const presenter = new ApiRunResultPresenter(
        undefined,
        undefined,
        undefined,
        makeRunStore(prisma17 as unknown as PrismaClient, prisma14 as unknown as PrismaClient)
      );

      const result = await presenter.call(friendlyId, authEnv(legacyCtx.environmentId));
      expect(result).toBeDefined();
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        // friendlyId / taskIdentifier / output+outputType round-trip across the version boundary identically.
        expect(result.id).toBe(friendlyId);
        expect(result.taskIdentifier).toBe("test-task");
        expect(result.output).toBe('"from-legacy"');
        expect(result.outputType).toBe("application/json");
      }
    }
  );

  // A run present on neither store returns undefined — the route's normal 404 surface. (Retention
  // handling is owned by the read-through/retention layer, not this presenter; a plain miss and a
  // past-retention id are indistinguishable here, both mapping to undefined.)
  heteroPostgresTest(
    "split: a missing id returns undefined (the route's normal 404 surface)",
    async ({ prisma14, prisma17 }) => {
      const friendlyId = legacyFriendlyId();
      const ctx = await fullSeed(prisma17 as unknown as PrismaClient, "past-ret-new");
      await fullSeed(prisma14 as unknown as PrismaClient, "past-ret-legacy");

      const presenter = new ApiRunResultPresenter(
        undefined,
        undefined,
        undefined,
        makeRunStore(prisma17 as unknown as PrismaClient, prisma14 as unknown as PrismaClient)
      );

      const result = await presenter.call(friendlyId, authEnv(ctx.environmentId));
      // Identical surface to a genuinely missing run: the route maps undefined → normal 404.
      expect(result).toBeUndefined();
    }
  );

  heteroPostgresTest(
    "single-DB passthrough: resolves from the one client; the legacy replica is never touched",
    async ({ prisma14, prisma17 }) => {
      const friendlyId = newFriendlyId();
      const ctx = await fullSeed(prisma17 as unknown as PrismaClient, "passthrough");
      await seedRunWithAttempt(prisma17 as unknown as PrismaClient, ctx, friendlyId, {
        status: "COMPLETED_SUCCESSFULLY",
        attempt: { status: "COMPLETED", output: '"single"', outputType: "application/json" },
      });

      // Single DB is the NEW leg; the run resolves there (single plain findFirst).
      const presenter = new ApiRunResultPresenter(
        undefined,
        undefined,
        undefined,
        makeRunStore(prisma17 as unknown as PrismaClient, prisma17 as unknown as PrismaClient)
      );

      const result = await presenter.call(friendlyId, authEnv(ctx.environmentId));
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        expect(result.id).toBe(friendlyId);
        expect(result.output).toBe('"single"');
      }

      // A tripwire legacy leg proves no second store is touched for a NEW-resident run.
      const presenter2 = new ApiRunResultPresenter(
        undefined,
        undefined,
        undefined,
        makeRunStore(
          prisma17 as unknown as PrismaClient,
          tripwireLegacy(prisma14 as unknown as PrismaClient)
        )
      );
      const result2 = await presenter2.call(friendlyId, authEnv(ctx.environmentId));
      expect(result2?.ok).toBe(true);
    }
  );

  // executionResultForTaskRun mapping is identical across split and single-DB for every status.
  heteroPostgresTest(
    "status parity: success / failed / canceled map identically in split and single-DB",
    async ({ prisma14, prisma17 }) => {
      const ctx = await fullSeed(prisma17 as unknown as PrismaClient, "parity");

      const successId = newFriendlyId();
      const failedId = newFriendlyId();
      const canceledId = newFriendlyId();

      await seedRunWithAttempt(prisma17 as unknown as PrismaClient, ctx, successId, {
        status: "COMPLETED_SUCCESSFULLY",
        attempt: { status: "COMPLETED", output: '"ok"', outputType: "application/json" },
      });
      await seedRunWithAttempt(prisma17 as unknown as PrismaClient, ctx, failedId, {
        status: "COMPLETED_WITH_ERRORS",
        attempt: {
          status: "FAILED",
          error: { type: "BUILT_IN_ERROR", name: "Error", message: "boom", stackTrace: "boom" },
        },
      });
      await seedRunWithAttempt(prisma17 as unknown as PrismaClient, ctx, canceledId, {
        status: "CANCELED",
      });

      const splitPresenter = new ApiRunResultPresenter(
        undefined,
        undefined,
        undefined,
        makeRunStore(
          prisma17 as unknown as PrismaClient,
          tripwireLegacy(prisma14 as unknown as PrismaClient)
        )
      );
      const passthroughPresenter = new ApiRunResultPresenter(
        undefined,
        undefined,
        undefined,
        makeRunStore(prisma17 as unknown as PrismaClient, prisma17 as unknown as PrismaClient)
      );

      for (const id of [successId, failedId, canceledId]) {
        const split = await splitPresenter.call(id, authEnv(ctx.environmentId));
        const single = await passthroughPresenter.call(id, authEnv(ctx.environmentId));
        expect(split).toEqual(single);
      }

      const success = await splitPresenter.call(successId, authEnv(ctx.environmentId));
      expect(success?.ok).toBe(true);

      const failed = await splitPresenter.call(failedId, authEnv(ctx.environmentId));
      expect(failed?.ok).toBe(false);

      const canceled = await splitPresenter.call(canceledId, authEnv(ctx.environmentId));
      expect(canceled?.ok).toBe(false);
      if (canceled && !canceled.ok) {
        expect(canceled.error.type).toBe("INTERNAL_ERROR");
      }
    }
  );
});

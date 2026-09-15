import { describe, expect, vi } from "vitest";

// The presenter module graph imports `~/v3/runStore.server`, which imports `~/db.server`
// at load. Stub it (the sibling runsRepository.readthrough.test.ts does the same) — the
// presenter under test is driven entirely through injected real containers, never the
// stubbed module singletons.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { PostgresRunStore } from "@internal/run-store";
import { createPostgresContainer, replicationContainerTest } from "@internal/testcontainers";
import { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import superjson from "superjson";
import { TestTaskPresenter } from "~/presenters/v3/TestTaskPresenter.server";
import { setupClickhouseReplication } from "../utils/replicationUtils";

vi.setConfig({ testTimeout: 90_000 });

type SeedContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

const JSON_TYPE = "application/json";
const SUPERJSON_TYPE = "application/super+json";

/**
 * Creates the org/project/(DEVELOPMENT) env parents plus the BackgroundWorker +
 * BackgroundWorkerTask the presenter resolves the task from. TaskRun FKs require
 * the org/project/env to exist on every DB a run is hydrated from.
 */
async function seedParents(
  prisma: PrismaClient,
  slug: string,
  triggerSource: "STANDARD" | "SCHEDULED"
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
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });

  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: `worker_${slug}`,
      contentHash: `hash-${slug}`,
      version: "20240101.1",
      engine: "V2",
      metadata: {},
      projectId: project.id,
      runtimeEnvironmentId: runtimeEnvironment.id,
    },
  });
  await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: `task_${slug}`,
      slug: "my-task",
      filePath: "src/trigger/my-task.ts",
      exportName: "myTask",
      workerId: worker.id,
      projectId: project.id,
      runtimeEnvironmentId: runtimeEnvironment.id,
      triggerSource,
    },
  });

  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: runtimeEnvironment.id,
  };
}

/** Mirrors the org/project/env parents onto a second DB with the SAME ids. */
async function mirrorParents(prisma: PrismaClient, ctx: SeedContext, slug: string): Promise<void> {
  await prisma.organization.create({
    data: { id: ctx.organizationId, title: `org-${slug}`, slug: `org-${slug}` },
  });
  await prisma.project.create({
    data: {
      id: ctx.projectId,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: ctx.organizationId,
      externalRef: `proj-${slug}`,
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ctx.environmentId,
      slug: `env-${slug}`,
      type: "DEVELOPMENT",
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      apiKey: `tr_dev_${slug}_b`,
      pkApiKey: `pk_dev_${slug}_b`,
      shortcode: `sc-${slug}-b`,
    },
  });
}

async function createRun(
  prisma: PrismaClient,
  ctx: SeedContext,
  run: {
    friendlyId: string;
    payload: string;
    payloadType?: string;
    createdAt?: Date;
    runTags?: string[];
  }
) {
  return prisma.taskRun.create({
    data: {
      friendlyId: run.friendlyId,
      taskIdentifier: "my-task",
      status: "COMPLETED_SUCCESSFULLY",
      payload: run.payload,
      payloadType: run.payloadType ?? JSON_TYPE,
      traceId: run.friendlyId,
      spanId: run.friendlyId,
      queue: "task/my-task",
      runTags: run.runTags ?? [],
      runtimeEnvironmentId: ctx.environmentId,
      projectId: ctx.projectId,
      organizationId: ctx.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
      ...(run.createdAt ? { createdAt: run.createdAt } : {}),
    },
  });
}

/** Copy a row created on one DB onto another DB with the SAME id. */
async function copyRunWithId(
  prisma: PrismaClient,
  ctx: SeedContext,
  source: { id: string; friendlyId: string; payload: string; payloadType: string; createdAt: Date }
) {
  const created = await createRun(prisma, ctx, {
    friendlyId: source.friendlyId,
    payload: source.payload,
    payloadType: source.payloadType,
    createdAt: source.createdAt,
  });
  await prisma.taskRun.update({
    where: { friendlyId: source.friendlyId },
    data: { id: source.id },
  });
  return created;
}

function envFor(ctx: SeedContext) {
  return {
    id: ctx.environmentId,
    type: "DEVELOPMENT" as const,
    projectId: ctx.projectId,
    organizationId: ctx.organizationId,
  };
}

/** A legacy-replica handle whose taskRun.findMany throws — proves it is never hydrated from. */
function throwingLegacyReplica(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === "taskRun") {
        return new Proxy((target as any).taskRun, {
          get(trTarget, trProp) {
            if (trProp === "findMany") {
              return async () => {
                throw new Error("legacy replica hydrate must not be invoked");
              };
            }
            return (trTarget as any)[trProp];
          },
        });
      }
      return (target as any)[prop];
    },
  }) as unknown as PrismaClient;
}

describe("TestTaskPresenter recent-payloads read-through (PG14 legacy + PG17 new)", () => {
  // payloadType parity: split union of NEW + legacy-replica, JSON-only, createdAt desc.
  replicationContainerTest(
    "split mode hydrates the 10-most-recent CH id-set as the union of NEW + legacy-replica rows, payloadType filtered, createdAt desc",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      // PG14 = legacy read replica AND the replication source feeding the CH id-set.
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const { url: newUrl } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });
      const prismaNew = new PrismaClient({ datasources: { db: { url: newUrl } } });

      try {
        const ctx = await seedParents(prisma, "split1", "STANDARD");
        await mirrorParents(prismaNew, ctx, "split1");

        const base = Date.now();
        const at = (offsetMs: number) => new Date(base - offsetMs);

        // All rows seeded on PG14 (legacy + replication source -> CH gets the full id-set).
        const legacyOld = await createRun(prisma, ctx, {
          friendlyId: "run_legacy_old",
          payload: JSON.stringify({ kind: "legacy-old" }),
          createdAt: at(4000),
        });
        const nonJson = await createRun(prisma, ctx, {
          friendlyId: "run_nonjson",
          payload: "binary-bytes",
          payloadType: "application/octet-stream",
          createdAt: at(3000),
        });
        const migratedSuper = await createRun(prisma, ctx, {
          friendlyId: "run_migrated_super",
          payload: JSON.stringify({ kind: "migrated-super" }),
          payloadType: SUPERJSON_TYPE,
          createdAt: at(2000),
        });
        const migratedJson = await createRun(prisma, ctx, {
          friendlyId: "run_migrated_json",
          payload: JSON.stringify({ kind: "migrated-json" }),
          createdAt: at(1000),
        });

        // The two "migrated" runs ALSO live on NEW (PG17), authoritative during retention.
        await copyRunWithId(prismaNew, ctx, {
          id: migratedSuper.id,
          friendlyId: migratedSuper.friendlyId,
          payload: migratedSuper.payload,
          payloadType: SUPERJSON_TYPE,
          createdAt: migratedSuper.createdAt,
        });
        await copyRunWithId(prismaNew, ctx, {
          id: migratedJson.id,
          friendlyId: migratedJson.friendlyId,
          payload: migratedJson.payload,
          payloadType: JSON_TYPE,
          createdAt: migratedJson.createdAt,
        });

        await setTimeout(1500);

        const presenter = new TestTaskPresenter(
          prisma,
          clickhouse,
          {
            splitEnabled: true,
            newClient: prismaNew,
            legacyReplica: prisma,
          },
          new PostgresRunStore({ prisma: prismaNew, readOnlyPrisma: prismaNew })
        );

        const result = await presenter.call({
          userId: "user_1",
          projectId: ctx.projectId,
          environment: envFor(ctx),
          taskIdentifier: "my-task",
        });

        expect(result.foundTask).toBe(true);
        if (!result.foundTask || result.triggerSource !== "STANDARD") {
          throw new Error("expected a STANDARD task");
        }

        // Union of the JSON/super+json rows across both DBs, createdAt desc, non-JSON absent.
        expect(result.runs.map((r) => r.friendlyId)).toEqual([
          "run_migrated_json",
          "run_migrated_super",
          "run_legacy_old",
        ]);
        expect(result.runs.map((r) => r.friendlyId)).not.toContain("run_nonjson");
        expect(result.runs.find((r) => r.id === nonJson.id)).toBeUndefined();

        // payloadType round-trips byte-identically across PG14/PG17.
        expect(result.runs.find((r) => r.id === migratedSuper.id)!.payloadType).toBe(
          SUPERJSON_TYPE
        );
        expect(result.runs.find((r) => r.id === migratedJson.id)!.payloadType).toBe(JSON_TYPE);
        expect(result.runs.find((r) => r.id === legacyOld.id)!.payloadType).toBe(JSON_TYPE);
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // Old in-retention run served from the legacy READ REPLICA only (no legacyWriter field exists).
  replicationContainerTest(
    "an in-retention legacy-only run hydrates from the legacy replica handle",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const { url: newUrl } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });
      const prismaNew = new PrismaClient({ datasources: { db: { url: newUrl } } });

      try {
        const ctx = await seedParents(prisma, "legacyonly", "STANDARD");
        await mirrorParents(prismaNew, ctx, "legacyonly");

        const legacyOnly = await createRun(prisma, ctx, {
          friendlyId: "run_legacy_only",
          payload: JSON.stringify({ kind: "legacy-only" }),
        });

        await setTimeout(1500);

        // The deps shape exposes only `legacyReplica` — there is no `legacyWriter`/primary
        // field, so the legacy primary is structurally unreachable from this hydrate.
        const presenter = new TestTaskPresenter(
          prisma,
          clickhouse,
          {
            splitEnabled: true,
            newClient: prismaNew,
            legacyReplica: prisma,
          },
          new PostgresRunStore({ prisma: prismaNew, readOnlyPrisma: prismaNew })
        );

        const result = await presenter.call({
          userId: "user_1",
          projectId: ctx.projectId,
          environment: envFor(ctx),
          taskIdentifier: "my-task",
        });

        if (!result.foundTask || result.triggerSource !== "STANDARD") {
          throw new Error("expected a STANDARD task");
        }
        expect(result.runs.map((r) => r.id)).toEqual([legacyOnly.id]);
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );

  // Passthrough (single-DB): one plain store read, the legacy replica never touched.
  replicationContainerTest(
    "single-DB passthrough hydrates from one store read and never touches the legacy replica",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const ctx = await seedParents(prisma, "passthrough", "STANDARD");
      const base = Date.now();
      const newer = await createRun(prisma, ctx, {
        friendlyId: "run_newer",
        payload: JSON.stringify({ n: 2 }),
        createdAt: new Date(base - 1000),
      });
      const older = await createRun(prisma, ctx, {
        friendlyId: "run_older",
        payload: JSON.stringify({ n: 1 }),
        createdAt: new Date(base - 2000),
      });
      await createRun(prisma, ctx, {
        friendlyId: "run_nonjson",
        payload: "bytes",
        payloadType: "application/octet-stream",
        createdAt: new Date(base - 500),
      });

      await setTimeout(1500);

      // No readThrough (split off). Inject a throwing legacy replica to prove the split branch
      // is never entered: a runStore whose findRuns drives the single `prisma` handle.
      const presenter = new TestTaskPresenter(
        prisma,
        clickhouse,
        {
          splitEnabled: false,
          legacyReplica: throwingLegacyReplica(prisma),
        },
        new PostgresRunStore({ prisma, readOnlyPrisma: prisma })
      );

      const result = await presenter.call({
        userId: "user_1",
        projectId: ctx.projectId,
        environment: envFor(ctx),
        taskIdentifier: "my-task",
      });

      if (!result.foundTask || result.triggerSource !== "STANDARD") {
        throw new Error("expected a STANDARD task");
      }
      // createdAt desc, JSON-only.
      expect(result.runs.map((r) => r.id)).toEqual([newer.id, older.id]);
    }
  );

  // SCHEDULED-source parity: same hydrate path, ScheduledRun mapping exercised.
  replicationContainerTest(
    "SCHEDULED task: split union parses to ScheduledRun shape identically to single-DB",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma, network }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

      const { url: newUrl } = await createPostgresContainer(network, {
        imageTag: "docker.io/postgres:17",
      });
      const prismaNew = new PrismaClient({ datasources: { db: { url: newUrl } } });

      try {
        const ctx = await seedParents(prisma, "scheduled", "SCHEDULED");
        await mirrorParents(prismaNew, ctx, "scheduled");

        // super+json so parsePacket revives the Date fields the ScheduledTaskPayload schema requires.
        const schedulePayload = superjson.stringify({
          scheduleId: "sched_1",
          type: "IMPERATIVE",
          timestamp: new Date("2026-01-01T00:00:00.000Z"),
          timezone: "UTC",
          externalId: "ext-1",
          upcoming: [new Date("2026-01-02T00:00:00.000Z")],
        });

        const base = Date.now();
        const migrated = await createRun(prisma, ctx, {
          friendlyId: "run_sched_new",
          payload: schedulePayload,
          payloadType: SUPERJSON_TYPE,
          createdAt: new Date(base - 1000),
        });
        await copyRunWithId(prismaNew, ctx, {
          id: migrated.id,
          friendlyId: migrated.friendlyId,
          payload: schedulePayload,
          payloadType: SUPERJSON_TYPE,
          createdAt: migrated.createdAt,
        });
        const legacy = await createRun(prisma, ctx, {
          friendlyId: "run_sched_legacy",
          payload: schedulePayload,
          payloadType: SUPERJSON_TYPE,
          createdAt: new Date(base - 2000),
        });

        await setTimeout(1500);

        const presenter = new TestTaskPresenter(
          prisma,
          clickhouse,
          {
            splitEnabled: true,
            newClient: prismaNew,
            legacyReplica: prisma,
          },
          new PostgresRunStore({ prisma: prismaNew, readOnlyPrisma: prismaNew })
        );

        const result = await presenter.call({
          userId: "user_1",
          projectId: ctx.projectId,
          environment: envFor(ctx),
          taskIdentifier: "my-task",
        });

        if (!result.foundTask || result.triggerSource !== "SCHEDULED") {
          throw new Error("expected a SCHEDULED task");
        }
        expect(result.runs.map((r) => r.id)).toEqual([migrated.id, legacy.id]);
        // Parsed ScheduledRun payload shape.
        expect(result.runs[0].payload.timezone).toBe("UTC");
        expect(result.runs[0].payload.externalId).toBe("ext-1");
      } finally {
        await prismaNew.$disconnect();
      }
    }
  );
});

// Item 4: the completed snapshot READ surface. findExecutionSnapshot + findManyExecutionSnapshots are
// intercepted alongside findLatest; a mirrored run's read preference follows the run ORG's LIVE per-org
// dial (not the constructed mode); and a MemoryDB-named mirrored head is never returned as null when the
// read replica lags (repair from the owning primary, else fail RETRIABLE). Proven end-to-end against
// REAL Postgres + REAL Redis (testcontainers, no mocks).
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  SnapshotReadUnavailableError,
  type SnapshotStoreDial,
} from "./taskRunExecutionSnapshotStore.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

const ROUTE = "logical:1";

type Env = Awaited<ReturnType<typeof seedSnapshotEnvironment>>;

function birthSnapshot(env: Env, id: string, createdAt: Date) {
  return {
    id,
    createdAt,
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

function transitionInput(
  env: Env,
  runId: string,
  id: string,
  previousSnapshotId: string,
  createdAt: Date
) {
  return {
    id,
    createdAt,
    run: { id: runId, status: "EXECUTING" as const, attemptNumber: 1 },
    snapshot: { executionStatus: "EXECUTING" as const, description: "Run started" },
    previousSnapshotId,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
}

async function insertPostgresOnlySnapshot(
  prisma: PrismaClient,
  env: Env,
  runId: string,
  id: string,
  createdAt: Date
) {
  await prisma.taskRunExecutionSnapshot.create({
    data: {
      id,
      runId,
      engine: "V2",
      executionStatus: "EXECUTING",
      description: "Postgres-only newer head",
      runStatus: "EXECUTING",
      environmentId: env.id,
      environmentType: env.type,
      projectId: env.projectId,
      organizationId: env.organizationId,
      createdAt,
    },
  });
}

// A reader whose per-org dial is fixed to `dial` for the fixture org (and off for every other org),
// so a test controls the read preference independently of the constructed mode.
function readerWithDial(
  delegate: PostgresRunStore,
  store: RedisSnapshotStore,
  env: Env,
  dial: SnapshotStoreDial,
  extra?: { resolvePrimaryReadClient?: (runId: string) => PrismaClient | undefined }
) {
  return new TaskRunExecutionSnapshotStore(delegate, {
    store,
    // The constructed mode is deliberately dual-write for EVERY reader, so any redis-read behavior can
    // only come from the injected per-org dial, never the mode.
    mode: "dual-write",
    logicalRunStoreRoute: ROUTE,
    resolveDial: (organizationId) => (organizationId === env.organizationId ? dial : "off"),
    ...extra,
  });
}

describe("TaskRunExecutionSnapshotStore reads: per-org dial", () => {
  containerTest(
    "a mirrored run's read source follows the run ORG's live dial, not the constructed mode",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();

        // Born MIRRORED (dual-write dial mirrors): Postgres AND MemoryDB both carry the birth head.
        const writer = readerWithDial(delegate, store, env, "dual-write");
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId, new Date()),
        });
        expect(await store.readBirthResidency(runId)).toBe("mirrored");

        // A NEWER Postgres-only row: a read served from Postgres returns it, one served from the
        // MemoryDB head does not.
        const pgOnlyId = generateInternalId();
        await insertPostgresOnlySnapshot(
          prisma,
          env,
          runId,
          pgOnlyId,
          new Date(Date.now() + 5_000)
        );

        // dial redis-read (constructed mode still dual-write) -> MemoryDB head, never the newer PG row.
        const redisRead = readerWithDial(delegate, store, env, "redis-read");
        expect((await redisRead.findLatestExecutionSnapshot(runId))?.id).toBe(birthId);
        const byId = await redisRead.findExecutionSnapshot({
          where: { runId, id: birthId },
        });
        expect(byId?.id).toBe(birthId);

        // dial dual-write -> the complete Postgres copy, so the newer PG row wins.
        const dualWrite = readerWithDial(delegate, store, env, "dual-write");
        expect((await dualWrite.findLatestExecutionSnapshot(runId))?.id).toBe(pgOnlyId);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("TaskRunExecutionSnapshotStore reads: redis-primary reproduction", () => {
  containerTest(
    "findExecutionSnapshot(by id) and findManyExecutionSnapshots(since) reproduce from MemoryDB with no TRES rows",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const t1Id = generateInternalId();
        const t2Id = generateInternalId();
        const base = Date.now();
        const birthAt = new Date(base);
        const t1At = new Date(base + 1_000);
        const t2At = new Date(base + 2_000);

        // Born REDIS-PRIMARY (redis-only): the TaskRun row is written but NO TRES rows.
        const writer = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId, birthAt),
        });
        await writer.createExecutionSnapshot(transitionInput(env, runId, t1Id, birthId, t1At));
        await writer.createExecutionSnapshot(transitionInput(env, runId, t2Id, t1Id, t2At));

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const reader = new TaskRunExecutionSnapshotStore(delegate, {
          store,
          mode: "redis-only",
          logicalRunStoreRoute: ROUTE,
        });

        // findExecutionSnapshot by id: reproduced from a MemoryDB point-read (no Postgres row exists).
        const since = await reader.findExecutionSnapshot({
          where: { id: birthId, runId },
          select: { createdAt: true },
        });
        expect(since).not.toBeNull();
        expect((since as { createdAt: Date }).createdAt.getTime()).toBe(birthAt.getTime());

        // findManyExecutionSnapshots since the birth: the MemoryDB window, newest first, checkpoint
        // included, take:50 -- exactly the shape getExecutionSnapshotsSince needs.
        const window = await reader.findManyExecutionSnapshots({
          where: { runId, isValid: true, createdAt: { gt: birthAt } },
          include: { checkpoint: true },
          orderBy: { createdAt: "desc" },
          take: 50,
        });
        expect(window.map((s) => s.id)).toEqual([t2Id, t1Id]);
        expect(window[0].checkpoint).toBeNull();

        // A MemoryDB miss fails closed, never an empty Postgres success.
        await store.dropRun(runId);
        await expect(
          reader.findExecutionSnapshot({
            where: { id: birthId, runId },
            select: { createdAt: true },
          })
        ).rejects.toBeInstanceOf(SnapshotReadUnavailableError);
        await expect(
          reader.findManyExecutionSnapshots({
            where: { runId, isValid: true, createdAt: { gt: birthAt } },
            include: { checkpoint: true },
            orderBy: { createdAt: "desc" },
            take: 50,
          })
        ).rejects.toBeInstanceOf(SnapshotReadUnavailableError);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("TaskRunExecutionSnapshotStore reads: primary-read repair", () => {
  containerTest(
    "a MemoryDB-named mirrored head whose Postgres row is absent never reads as null",
    async ({ prisma, redisOptions }) => {
      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const birthId = generateInternalId();
        const headId = generateInternalId();

        // Born MIRRORED, then a transition: MemoryDB names `headId` as the committed head.
        const writer = readerWithDial(delegate, store, env, "dual-write");
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: birthSnapshot(env, birthId, new Date()),
        });
        await writer.createExecutionSnapshot(
          transitionInput(env, runId, headId, birthId, new Date(Date.now() + 1_000))
        );

        // Baseline: while the Postgres row exists, the redis-read head hydrates non-null.
        const reader = readerWithDial(delegate, store, env, "redis-read");
        expect((await reader.findLatestExecutionSnapshot(runId))?.id).toBe(headId);

        // Now the head's Postgres row is absent (a lagging read replica). The read must NOT return null.
        await prisma.taskRunExecutionSnapshot.delete({ where: { id: headId } });

        // No primary reachable -> fail RETRIABLE.
        await expect(reader.findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
          SnapshotReadUnavailableError
        );

        // A primary seam is consulted; here it too lacks the row (single DB), so still non-null-or-throw.
        const repairing = readerWithDial(delegate, store, env, "redis-read", {
          resolvePrimaryReadClient: () => prisma,
        });
        await expect(repairing.findLatestExecutionSnapshot(runId)).rejects.toBeInstanceOf(
          SnapshotReadUnavailableError
        );
      } finally {
        await store.quit();
      }
    }
  );
});

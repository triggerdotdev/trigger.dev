import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import { snapshotKeys } from "./snapshotKeys.js";
import { buildCreateRunData, seedSnapshotEnvironment } from "./testFixtures/snapshotIdFixture.js";

// Instrument the real storage implementation. No replacement infrastructure or supplied route.
class CountingSnapshotStore extends RedisSnapshotStore {
  residencyReads = 0;
  override readStateVersion(runId: string) {
    this.residencyReads++;
    return super.readStateVersion(runId);
  }
  override readBirthResidency(runId: string) {
    this.residencyReads++;
    return super.readBirthResidency(runId);
  }
}

class CountingPostgresStore extends PostgresRunStore {
  latestReads = 0;
  override findLatestExecutionSnapshot(
    ...args: Parameters<PostgresRunStore["findLatestExecutionSnapshot"]>
  ) {
    this.latestReads++;
    return super.findLatestExecutionSnapshot(...args);
  }
}

describe("server-only snapshot routing", () => {
  containerTest(
    "a mirrored birth keeps its residency and repairs a missing head",
    async ({ prisma, redisOptions }) => {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const birthId = generateInternalId();
      const postgresHead = generateInternalId();
      const nextHead = generateInternalId();
      const startedAt = new Date();
      const postgres = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const redis = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const faultClient = createRedisClient(redisOptions);
      const options = {
        store: redis,
        mode: "redis-read" as const,
        logicalRunStoreRoute: "single",
        resolvePrimaryReadClient: () => prisma,
      };
      const snapshotFields = {
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      };
      try {
        let birthDialChecks = 0;
        const producer = new TaskRunExecutionSnapshotStore(postgres, {
          ...options,
          resolveDial: async (_organizationId, organizationFlags) => {
            expect(organizationFlags).toEqual({ snapshotStoreMode: "redis-read" });
            return ++birthDialChecks === 1 ? "redis-read" : "off";
          },
        });
        await producer.createRun({
          organizationFlags: { snapshotStoreMode: "redis-read" },
          data: buildCreateRunData(runId, env),
          snapshot: {
            ...snapshotFields,
            id: birthId,
            createdAt: startedAt,
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "Run was created",
            runStatus: "PENDING",
          },
        });
        expect((await postgres.findLatestExecutionSnapshot(runId, prisma))?.metadata).toEqual({
          snapshotStore: { version: 1, residency: "mirrored" },
        });
        expect(birthDialChecks).toBe(1);
        const lagging = new TaskRunExecutionSnapshotStore(postgres, {
          ...options,
          resolveDial: async () => undefined,
        });
        expect(await lagging.readSnapshotRoute(runId, env.organizationId)).toEqual({
          runId,
          organizationId: env.organizationId,
          residency: "mirrored",
        });
        await lagging.createExecutionSnapshot({
          ...snapshotFields,
          id: postgresHead,
          createdAt: new Date(startedAt.getTime() + 1),
          previousSnapshotId: birthId,
          run: { id: runId, status: "PENDING" },
          snapshot: { executionStatus: "QUEUED", description: "Queued on a lagging off pod" },
        });
        expect((await redis.getLatest(runId))?.id).toBe(postgresHead);
        let readDialChecks = 0;
        const reader = new TaskRunExecutionSnapshotStore(postgres, {
          ...options,
          resolveDial: async () => {
            readDialChecks++;
            return "redis-read";
          },
        });
        expect(
          (await reader.findLatestExecutionSnapshot(runId, prisma, env.id, env.organizationId))?.id
        ).toBe(postgresHead);
        expect(readDialChecks).toBe(1);
        // Lose only the pointer. The committed entry and PG head remain authoritative evidence;
        // the existing next transition must restore the pointer and advance both stores.
        expect(await faultClient.del(snapshotKeys(runId).cur)).toBe(1);
        expect(await redis.getLatest(runId)).toBeNull();
        await reader.createExecutionSnapshot({
          ...snapshotFields,
          id: nextHead,
          createdAt: new Date(startedAt.getTime() + 2),
          previousSnapshotId: postgresHead,
          run: { id: runId, status: "EXECUTING", attemptNumber: 1 },
          snapshot: {
            executionStatus: "EXECUTING",
            description: "Continued after forward promotion",
          },
        });
        expect((await reader.findLatestExecutionSnapshot(runId, prisma, env.id))?.id).toBe(
          nextHead
        );
        expect((await redis.getLatest(runId))?.id).toBe(nextHead);
        expect(await redis.readPendingState(runId)).toEqual({
          prepared: false,
          quarantined: false,
        });
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(3);
        const rows = await prisma.taskRunExecutionSnapshot.findMany({ where: { runId } });
        expect(
          rows.every(
            (row) =>
              JSON.stringify(row.metadata) ===
              JSON.stringify({
                snapshotStore: { version: 1, residency: "mirrored" },
              })
          )
        ).toBe(true);
      } finally {
        await Promise.all([redis.quit(), faultClient.quit()]);
      }
    }
  );

  containerTest(
    "dequeue's existing organization context reads a cold Redis-primary run without a Postgres query",
    async ({ prisma, redisOptions }) => {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const snapshotId = generateInternalId();
      const postgres = new CountingPostgresStore({ prisma, readOnlyPrisma: prisma });
      const redis = new CountingSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const options = {
        store: redis,
        mode: "redis-only" as const,
        resolveDial: (orgId: string) =>
          orgId === env.organizationId ? ("redis-only" as const) : ("off" as const),
        logicalRunStoreRoute: "single",
      };
      try {
        const writer = new TaskRunExecutionSnapshotStore(postgres, options);
        await writer.createRun({
          data: buildCreateRunData(runId, env),
          snapshot: {
            id: snapshotId,
            engine: "V2",
            executionStatus: "RUN_CREATED",
            description: "Run was created",
            runStatus: "PENDING",
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          },
        });
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        const coldReader = new TaskRunExecutionSnapshotStore(postgres, options);
        const latest = await coldReader.findLatestExecutionSnapshot(
          runId,
          prisma,
          env.id,
          env.organizationId
        );
        expect(latest?.id).toBe(snapshotId);
        expect(latest?.organizationId).toBe(env.organizationId);
        expect(postgres.latestReads).toBe(0);
        const laggingReader = new TaskRunExecutionSnapshotStore(postgres, {
          ...options,
          resolveDial: () => undefined,
        });
        expect(await laggingReader.readSnapshotRoute(runId, env.organizationId)).toEqual({
          runId,
          organizationId: env.organizationId,
          residency: "redis-primary",
        });
        expect(
          (
            await laggingReader.findLatestExecutionSnapshot(
              runId,
              prisma,
              env.id,
              env.organizationId
            )
          )?.id
        ).toBe(snapshotId);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
        await redis.dropRun(runId);
        await expect(laggingReader.readSnapshotRoute(runId, env.organizationId)).rejects.toThrow(
          "durable residency unresolved"
        );
        await expect(
          laggingReader.readSnapshotRoute(generateInternalId(), env.organizationId)
        ).rejects.toThrow("existing snapshot is absent from both stores");
        await redis.quit();
        await expect(laggingReader.readSnapshotRoute(runId, env.organizationId)).rejects.toThrow(
          "durable residency unresolved"
        );
      } finally {
        await redis.quit();
      }
    }
  );

  containerTest(
    "a cold off-org reader uses the original Postgres read during a snapshot Redis outage",
    async ({ prisma, redisOptions }) => {
      const env = await seedSnapshotEnvironment(prisma);
      const runId = generateInternalId();
      const snapshotId = generateInternalId();
      const postgres = new CountingPostgresStore({ prisma, readOnlyPrisma: prisma });
      await postgres.createRun({
        data: buildCreateRunData(runId, env),
        snapshot: {
          id: snapshotId,
          engine: "V2",
          executionStatus: "RUN_CREATED",
          description: "Run was created",
          runStatus: "PENDING",
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
        },
      });
      const redis = new CountingSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      // A genuinely unusable snapshot connection, not a throwing fake resolver.
      await redis.quit();
      const reader = new TaskRunExecutionSnapshotStore(postgres, {
        store: redis,
        mode: "redis-only",
        resolveDial: (orgId) => (orgId === env.organizationId ? "off" : "redis-only"),
        logicalRunStoreRoute: "single",
      });

      const latest = await reader.findLatestExecutionSnapshot(runId, prisma, env.id);
      expect(latest?.id).toBe(snapshotId);
      expect(latest?.organizationId).toBe(env.organizationId);
      expect(postgres.latestReads).toBe(1);
      expect(redis.residencyReads).toBe(0);

      await reader.createExecutionSnapshot({
        id: generateInternalId(),
        createdAt: new Date(latest!.createdAt.getTime() + 1),
        previousSnapshotId: snapshotId,
        run: { id: runId, status: "PENDING" },
        snapshot: { executionStatus: "QUEUED", description: "Off-org transition" },
        environmentId: env.id,
        environmentType: env.type,
        projectId: env.projectId,
        organizationId: env.organizationId,
      });
      expect(redis.residencyReads).toBe(0);

      // Each part receives server-owned context explicitly, without a pod-local identity cache.
      expect((await reader.readSnapshotRoute(runId, env.organizationId))?.residency).toBe(
        "postgres"
      );
      const latestReadsBeforeCursor = postgres.latestReads;
      expect(
        await reader.findExecutionSnapshot(
          {
            where: { id: snapshotId, runId, environmentId: env.id },
            select: { createdAt: true },
          },
          prisma,
          env.organizationId
        )
      ).toEqual({ createdAt: latest!.createdAt });
      expect(postgres.latestReads).toBe(latestReadsBeforeCursor);
      expect(
        await reader.findManyExecutionSnapshots(
          {
            where: {
              runId,
              isValid: true,
              createdAt: { gt: new Date(latest!.createdAt.getTime() + 1) },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          },
          prisma,
          env.organizationId
        )
      ).toEqual([]);
      expect(
        await reader.findSnapshotCompletedWaitpointIdsWithPresence(
          snapshotId,
          prisma,
          runId,
          env.organizationId
        )
      ).toEqual({ present: true, ids: [] });
      expect(redis.residencyReads).toBe(0);

      // A different process may receive /snapshots/since before /snapshots/latest. Its cursor query
      // retains the original narrow projection. Explicit context, not a preceding request, gates Redis.
      const cursorReader = new TaskRunExecutionSnapshotStore(postgres, {
        store: redis,
        mode: "redis-only",
        resolveDial: (orgId) => (orgId === env.organizationId ? "off" : "redis-only"),
        logicalRunStoreRoute: "single",
      });
      expect(
        await cursorReader.findExecutionSnapshot(
          {
            where: { id: snapshotId, runId, environmentId: env.id },
            select: { createdAt: true },
          },
          prisma,
          env.organizationId
        )
      ).toEqual({ createdAt: latest!.createdAt });
      expect(
        await cursorReader.findManyExecutionSnapshots(
          {
            where: {
              runId,
              isValid: true,
              createdAt: { gt: new Date(latest!.createdAt.getTime() + 1) },
            },
            orderBy: { createdAt: "desc" },
            take: 50,
          },
          prisma,
          env.organizationId
        )
      ).toEqual([]);
      expect(redis.residencyReads).toBe(0);
    }
  );
});

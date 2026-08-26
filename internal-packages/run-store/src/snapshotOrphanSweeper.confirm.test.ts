// Rule 2 deletes a whole keyspace on the strength of "findRunsByIds returned no row for it". The
// catch in #sweepBatch covers a lookup that THROWS; it cannot see a lookup that succeeds and is
// incomplete, and a row that exists but did not come back reads exactly like a run that never
// existed. `findRunsByIds` partitions ids by residency and asks each store only for its own, and
// with no client passed it reads each store's replica — both sound today, but neither is something
// this delete path can verify.
//
// A false negative leaks keys, which is bounded and recoverable. A false positive destroys a live
// run's execution state. So deletion requires two sightings across the confirm window, and these
// tests pin that: a single pass never deletes, however old the keyspace.
import { describe, expect } from "vitest";
import { containerTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { PostgresRunStore } from "./PostgresRunStore.js";
import { RedisSnapshotStore, snapshotKeys } from "./redisSnapshotStore.js";
import { entryFromCreateRun } from "./snapshotEntry.js";
import { SnapshotOrphanSweeper } from "./snapshotOrphanSweeper.js";
import type { RunStore } from "./types.js";
import {
  buildCreateRunData,
  seedSnapshotEnvironment,
  type SnapshotFixtureEnv,
} from "./testFixtures/snapshotIdFixture.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;
const ORPHAN_AGE_MS = 60 * 60 * 1000;

function birthEntry(runId: string, env: SnapshotFixtureEnv, createdAt: Date) {
  const snapshot = {
    id: generateInternalId(),
    engine: "V2" as const,
    executionStatus: "RUN_CREATED" as const,
    description: "Run was created",
    runStatus: "PENDING" as const,
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
  return entryFromCreateRun({ id: snapshot.id, runId, createdAt }, snapshot);
}

describe("rule 2 requires a second sighting", () => {
  containerTest(
    "one pass marks an orphan and deletes nothing, however old the keyspace",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        // A thousand times the age gate. Age is not what holds the deletion back.
        const ancient = new Date(Date.now() - 1000 * ORPHAN_AGE_MS);
        await store.append({
          entry: birthEntry(runId, env, ancient),
          kind: "birth",
          isTerminal: false,
        });

        const first = await sweeper.sweep();

        expect(first.deleted).toBe(0);
        expect(first.pendingDeletion).toBe(1);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);

        const second = await sweeper.sweep();

        expect(second.deleted).toBe(1);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(0);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "a marked keyspace is not deleted until the confirm window has passed",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // An hour. Passes minutes apart must not convert a candidate.
        confirmOrphanAfterMs: 60 * 60 * 1000,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await store.append({
          entry: birthEntry(runId, env, new Date(Date.now() - 2 * ORPHAN_AGE_MS)),
          kind: "birth",
          isTerminal: false,
        });

        await sweeper.sweep();
        const second = await sweeper.sweep();
        const third = await sweeper.sweep();

        expect(second.deleted).toBe(0);
        expect(second.pendingDeletion).toBe(1);
        expect(third.deleted).toBe(0);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "a transient miss followed by a found run does not delete, and does not leave the keyspace pre-authorised",
    async ({ prisma, redisOptions }) => {
      // The case the guard exists for. Pass 1 gets an incomplete answer and marks the keyspace.
      // Pass 2 sees the run, so it must clear the mark: were the mark to survive, a LATER genuine
      // absence would delete on its own first sighting and the two-sighting rule would be gone.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const real = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const probe = createRedisClient(redisOptions, { onError: () => {} });

      let lie = true;
      const flaky = {
        ...real,
        findRunsByIds: (...args: unknown[]) =>
          lie
            ? // Succeeds and is incomplete: exactly what the catch cannot see.
              Promise.resolve(new Map())
            : (real.findRunsByIds as (...rest: unknown[]) => Promise<Map<string, unknown>>).apply(
                real,
                args
              ),
      } as unknown as RunStore;

      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: flaky,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        confirmOrphanAfterMs: 0,
      });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await store.append({
          entry: birthEntry(runId, env, new Date(Date.now() - 2 * ORPHAN_AGE_MS)),
          kind: "birth",
          isTerminal: false,
        });
        // The run is alive and terminal in Postgres the whole time. Only the lookup lies.
        await prisma.taskRun.create({
          data: { ...buildCreateRunData(runId, env), status: "COMPLETED_SUCCESSFULLY" },
        });

        const first = await sweeper.sweep();
        expect(first.deleted).toBe(0);
        expect(first.pendingDeletion).toBe(1);

        lie = false;
        const second = await sweeper.sweep();
        expect(second.deleted).toBe(0);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);

        // The run vanishes for real. With the mark cleared this is a first sighting again.
        lie = true;
        const third = await sweeper.sweep();
        expect(third.deleted).toBe(0);
        expect(third.pendingDeletion).toBe(1);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);

        const fourth = await sweeper.sweep();
        expect(fourth.deleted).toBe(1);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
});

describe("the marker cannot expire out from under a candidate", () => {
  containerTest(
    "a marked keyspace still carries its mark after the whole keyspace is re-read",
    async ({ prisma, redisOptions }) => {
      // The marker used to be a key with its own TTL derived from the confirm window, which could
      // be shorter than the interval between passes: the marker written at T was gone by
      // T+interval, every pass wrote a fresh one, and rule 2 deleted nothing while reporting clean.
      // It is now a field on the run's `seq` hash, so it lives exactly as long as the keyspace and
      // there is no lifetime left to misconfigure.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await store.append({
          entry: birthEntry(runId, env, new Date(Date.now() - 2 * ORPHAN_AGE_MS)),
          kind: "birth",
          isTerminal: false,
        });

        expect((await sweeper.sweep()).pendingDeletion).toBe(1);

        // The mark is a field on seq, and it carries no expiry of its own.
        expect(await probe.hget(snapshotKeys(runId).seq, "orph")).not.toBeNull();
        expect(await probe.pttl(snapshotKeys(runId).seq)).toBe(-1);

        expect((await sweeper.sweep()).deleted).toBe(1);
        // And it went with the keyspace rather than outliving it.
        expect(await probe.exists(snapshotKeys(runId).seq)).toBe(0);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
});

describe("a run seen alive clears its marker", () => {
  containerTest(
    "a lie, then a LIVE run, then a lie again does not delete",
    async ({ prisma, redisOptions }) => {
      // The hole a long marker lifetime opens. Only terminal runs used to clear the marker, so a
      // keyspace marked by an incomplete lookup and then seen ALIVE kept its mark. A later genuine
      // absence would then find a mature marker and delete on what is really a first sighting.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const real = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const probe = createRedisClient(redisOptions, { onError: () => {} });

      let lie = true;
      const flaky = {
        ...real,
        findRunsByIds: (...args: unknown[]) =>
          lie
            ? Promise.resolve(new Map())
            : (real.findRunsByIds as (...rest: unknown[]) => Promise<Map<string, unknown>>).apply(
                real,
                args
              ),
      } as unknown as RunStore;

      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: flaky,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        confirmOrphanAfterMs: 0,
      });

      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        await store.append({
          entry: birthEntry(runId, env, new Date(Date.now() - 2 * ORPHAN_AGE_MS)),
          kind: "birth",
          isTerminal: false,
        });
        // EXECUTING, not terminal. This run never reaches rule 1, so rule 1 cannot be what clears
        // the mark; a SUSPENDED run can legitimately sit here for weeks.
        await prisma.taskRun.create({
          data: { ...buildCreateRunData(runId, env), status: "EXECUTING" },
        });

        expect((await sweeper.sweep()).pendingDeletion).toBe(1);

        lie = false;
        const seenAlive = await sweeper.sweep();
        expect(seenAlive.skipped).toBeGreaterThan(0);
        expect(seenAlive.deleted).toBe(0);

        lie = true;
        const afterAlive = await sweeper.sweep();
        // A first sighting again, because being seen alive cleared the mark.
        expect(afterAlive.deleted).toBe(0);
        expect(afterAlive.pendingDeletion).toBe(1);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
});

describe("a pass can stop inside a budget", () => {
  containerTest(
    "an already-passed deadline yields a partial pass",
    async ({ prisma, redisOptions }) => {
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
      });

      try {
        const result = await sweeper.sweep({ deadline: Date.now() - 1 });

        // redis-worker redelivers a job that outlives its visibility timeout, and nothing extends it,
        // so a pass that cannot stop on its own runs concurrently with itself.
        expect(result.partial).toBe(true);
        expect(result.scanned).toBe(0);
      } finally {
        await sweeper.quit();
      }
    }
  );

  containerTest("an aborted signal yields a partial pass", async ({ prisma, redisOptions }) => {
    const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const sweeper = new SnapshotOrphanSweeper({
      redisOptions,
      runStore: runStore as unknown as RunStore,
      completedTtlMs: COMPLETED_TTL_MS,
    });
    const controller = new AbortController();
    controller.abort();

    try {
      const result = await sweeper.sweep({ signal: controller.signal });
      expect(result.partial).toBe(true);
    } finally {
      await sweeper.quit();
    }
  });

  containerTest("a pass with budget to spare is not partial", async ({ prisma, redisOptions }) => {
    const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
    const sweeper = new SnapshotOrphanSweeper({
      redisOptions,
      runStore: runStore as unknown as RunStore,
      completedTtlMs: COMPLETED_TTL_MS,
    });

    try {
      const result = await sweeper.sweep({ deadline: Date.now() + 60_000 });
      expect(result.partial).toBe(false);
    } finally {
      await sweeper.quit();
    }
  });
});

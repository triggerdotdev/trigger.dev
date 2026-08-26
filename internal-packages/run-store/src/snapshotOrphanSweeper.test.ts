// The sweep deletes whole keyspaces, so most of these tests are about what it must NOT touch: a live
// run, a young orphan, and any batch whose Postgres lookup did not come back.
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

function birthEntry(runId: string, env: SnapshotFixtureEnv, createdAt: Date, terminal = false) {
  const snapshot = {
    id: generateInternalId(),
    engine: "V2" as const,
    executionStatus: terminal ? ("FINISHED" as const) : ("RUN_CREATED" as const),
    description: "Run was created",
    runStatus: terminal ? ("CANCELED" as const) : ("PENDING" as const),
    environmentId: env.id,
    environmentType: env.type,
    projectId: env.projectId,
    organizationId: env.organizationId,
  };
  return entryFromCreateRun({ id: snapshot.id, runId, createdAt }, snapshot);
}

describe("SnapshotOrphanSweeper", () => {
  containerTest(
    "rule 1 expires a terminal run whose keyspace never got one",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // Rule 2 needs two sightings. These cases are about WHICH keyspaces it picks, not about
        // the confirm window, so the window is zero and they sweep twice. The window itself has
        // its own tests below.
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        // Non-terminal append, so no expiry is ever set — the lost-TTL-set case.
        await store.append({
          entry: birthEntry(runId, env, new Date()),
          kind: "birth",
          isTerminal: false,
        });
        await prisma.taskRun.create({
          data: { ...buildCreateRunData(runId, env), status: "COMPLETED_SUCCESSFULLY" },
        });

        const keys = snapshotKeys(runId);
        expect(await probe.pttl(keys.e)).toBe(-1);

        const result = await sweeper.sweep();

        expect(result.expired).toBe(1);
        expect(result.deleted).toBe(0);
        for (const key of [keys.e, keys.idx, keys.cur, keys.seq]) {
          const ttl = await probe.pttl(key);
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(COMPLETED_TTL_MS);
        }
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "rule 1 leaves a keyspace that already has an expiry alone",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // Rule 2 needs two sightings. These cases are about WHICH keyspaces it picks, not about
        // the confirm window, so the window is zero and they sweep twice. The window itself has
        // its own tests below.
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        // A healthy terminal append sets the completion TTL itself.
        await store.append({
          entry: birthEntry(runId, env, new Date(), true),
          kind: "birth",
          isTerminal: true,
        });
        await prisma.taskRun.create({
          data: { ...buildCreateRunData(runId, env), status: "CANCELED" },
        });

        const before = await probe.pttl(snapshotKeys(runId).e);
        const result = await sweeper.sweep();

        expect(result.expired).toBe(0);
        expect(result.skipped).toBe(1);
        const after = await probe.pttl(snapshotKeys(runId).e);
        // Not extended: the sweep must not keep resetting a countdown that is already running.
        expect(after).toBeLessThanOrEqual(before);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "rule 2 deletes a keyspace with no run row, cycle keys included",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // Rule 2 needs two sightings. These cases are about WHICH keyspaces it picks, not about
        // the confirm window, so the window is zero and they sweep twice. The window itself has
        // its own tests below.
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const old = new Date(Date.now() - 2 * ORPHAN_AGE_MS);

        // The crashed birth: an entry, no Postgres run, non-terminal so no expiry.
        await store.append({
          entry: birthEntry(runId, env, old),
          kind: "birth",
          isTerminal: false,
        });
        await store.append({
          entry: birthEntry(runId, env, old),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_1", index: 0 }] },
        });

        const cyclesBefore = await probe.keys(`snap:{${runId}}:wp:*`);
        expect(cyclesBefore.length).toBeGreaterThan(0);

        await sweeper.sweep();
        const result = await sweeper.sweep();

        expect(result.deleted).toBe(1);
        const keys = snapshotKeys(runId);
        for (const key of [keys.e, keys.idx, keys.cur, keys.seq]) {
          expect(await probe.exists(key)).toBe(0);
        }
        expect(await probe.keys(`snap:{${runId}}:wp:*`)).toEqual([]);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest("rule 2 spares a young orphan", async ({ prisma, redisOptions }) => {
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
      // Written just now: the Postgres insert of a healthy birth may still be in flight.
      await store.append({
        entry: birthEntry(runId, env, new Date()),
        kind: "birth",
        isTerminal: false,
      });

      const result = await sweeper.sweep();

      expect(result.deleted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);
    } finally {
      await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
    }
  });

  containerTest(
    "never touches a live run, however old its keyspace",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // Rule 2 needs two sightings. These cases are about WHICH keyspaces it picks, not about
        // the confirm window, so the window is zero and they sweep twice. The window itself has
        // its own tests below.
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const ancient = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

        // A run waiting on an untimed token can sit non-terminal for weeks. Reaping it would drop
        // live state, which is the failure this rule exists to avoid.
        await store.append({
          entry: birthEntry(runId, env, ancient),
          kind: "birth",
          isTerminal: false,
        });
        await prisma.taskRun.create({
          data: { ...buildCreateRunData(runId, env), status: "WAITING_TO_RESUME" },
        });

        const result = await sweeper.sweep();

        expect(result.deleted).toBe(0);
        expect(result.expired).toBe(0);
        expect(result.skipped).toBe(1);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);
        expect(await probe.pttl(snapshotKeys(runId).e)).toBe(-1);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest("a dry run reports but changes nothing", async ({ prisma, redisOptions }) => {
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
      const orphan = generateInternalId();
      const terminal = generateInternalId();
      const old = new Date(Date.now() - 2 * ORPHAN_AGE_MS);

      await store.append({ entry: birthEntry(orphan, env, old), kind: "birth", isTerminal: false });
      await store.append({
        entry: birthEntry(terminal, env, new Date()),
        kind: "birth",
        isTerminal: false,
      });
      await prisma.taskRun.create({
        data: { ...buildCreateRunData(terminal, env), status: "COMPLETED_SUCCESSFULLY" },
      });

      const result = await sweeper.sweep({ dryRun: true });

      // A dry pass writes no marker, so an unconfirmed rule 2 candidate reports as pending rather
      // than as a deletion. That is what a real pass would do at this instant, which is the honest
      // answer for a preview: nothing is confirmed yet, so nothing would be deleted yet.
      expect(result.deleted).toBe(0);
      expect(result.pendingDeletion).toBe(1);
      expect(result.expired).toBe(1);
      expect(await probe.exists(snapshotKeys(orphan).e)).toBe(1);
      expect(await probe.pttl(snapshotKeys(terminal).e)).toBe(-1);
    } finally {
      await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
    }
  });

  containerTest(
    "skips a batch whose run lookup failed, and deletes nothing",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const failing = {
        findRunsByIds: async () => {
          throw new Error("run lookup unavailable");
        },
      } as unknown as RunStore;
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: failing,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // Rule 2 needs two sightings. These cases are about WHICH keyspaces it picks, not about
        // the confirm window, so the window is zero and they sweep twice. The window itself has
        // its own tests below.
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const old = new Date(Date.now() - 2 * ORPHAN_AGE_MS);
        await store.append({
          entry: birthEntry(runId, env, old),
          kind: "birth",
          isTerminal: false,
        });

        // A failed lookup says nothing about whether the run exists, and rule 2 deletes a whole
        // keyspace. The sweep must resolve rather than throw, and must reap nothing.
        const result = await sweeper.sweep();

        expect(result.deleted).toBe(0);
        expect(result.skipped).toBeGreaterThan(0);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "discovers and reaps a keyspace whose entries are all invalid",
    async ({ prisma, redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // Rule 2 needs two sightings. These cases are about WHICH keyspaces it picks, not about
        // the confirm window, so the window is zero and they sweep twice. The window itself has
        // its own tests below.
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const old = new Date(Date.now() - 2 * ORPHAN_AGE_MS);

        // The append script writes `cur` and indexes the entry only when it is valid, so a keyspace
        // whose entries all carry an error has neither. A sweep that discovers keyspaces by their
        // `cur` key would never see this one, and neither rule would ever apply to it.
        await store.append({
          entry: { ...birthEntry(runId, env, old), error: "stale write" },
          kind: "birth",
          isTerminal: false,
        });

        const keys = snapshotKeys(runId);
        expect(await probe.exists(keys.e)).toBe(1);
        expect(await probe.exists(keys.cur)).toBe(0);

        await sweeper.sweep();
        const result = await sweeper.sweep();

        expect(result.deleted).toBe(1);
        expect(await probe.exists(keys.e)).toBe(0);
        expect(await probe.exists(keys.seq)).toBe(0);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest(
    "still finds keyspaces when the client carries a key prefix",
    async ({ prisma, redisOptions }) => {
      // ioredis prepends its keyPrefix to keys for ordinary commands, but NOT to a SCAN MATCH
      // pattern, and it returns matched keys with the prefix still on them. The engine sets a
      // prefix on every other Redis client it builds, so a sweep that ignored this would match
      // nothing and report a clean pass: a safety net that silently protects nothing.
      const prefixed = { ...(redisOptions as object), keyPrefix: "engine:" } as never;
      const store = new RedisSnapshotStore({
        redisOptions: prefixed,
        completedTtlMs: COMPLETED_TTL_MS,
      });
      const runStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const sweeper = new SnapshotOrphanSweeper({
        redisOptions: prefixed,
        runStore: runStore as unknown as RunStore,
        completedTtlMs: COMPLETED_TTL_MS,
        orphanAgeMs: ORPHAN_AGE_MS,
        // Rule 2 needs two sightings. These cases are about WHICH keyspaces it picks, not about
        // the confirm window, so the window is zero and they sweep twice. The window itself has
        // its own tests below.
        confirmOrphanAfterMs: 0,
      });
      const probe = createRedisClient(prefixed, { onError: () => {} });
      try {
        const env = await seedSnapshotEnvironment(prisma);
        const runId = generateInternalId();
        const old = new Date(Date.now() - 2 * ORPHAN_AGE_MS);

        await store.append({
          entry: birthEntry(runId, env, old),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_1", index: 0 }] },
        });

        await sweeper.sweep();
        const result = await sweeper.sweep();

        expect(result.scanned).toBe(1);
        expect(result.deleted).toBe(1);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(0);
        expect(await probe.exists(`snap:{${runId}}:wp:1`)).toBe(0);
      } finally {
        await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  containerTest("processes every keyspace across batches", async ({ prisma, redisOptions }) => {
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
      const old = new Date(Date.now() - 2 * ORPHAN_AGE_MS);
      const orphans = Array.from({ length: 5 }, () => generateInternalId());
      for (const runId of orphans) {
        await store.append({
          entry: birthEntry(runId, env, old),
          kind: "birth",
          isTerminal: false,
        });
      }

      await sweeper.sweep({ batchSize: 2 });
      const result = await sweeper.sweep({ batchSize: 2 });

      expect(result.deleted).toBe(5);
      for (const runId of orphans) {
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(0);
      }
    } finally {
      await Promise.all([store.quit(), sweeper.quit(), probe.quit().catch(() => {})]);
    }
  });
});

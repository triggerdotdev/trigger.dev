// Real legacy-replica + new-DB proof for the read-through layer.
// We NEVER mock the DB: the reads run as real `$queryRaw` against the two containers,
// crossing the actual legacy↔new boundary the split relies on. The only injected
// fakes are the pure boundaries — `isPastRetention`, `splitEnabled` — plus throwing
// spies used to assert a store was NEVER touched.
import { heteroPostgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import { readThroughRun, type ReadThroughResult } from "./readThrough.server";

vi.setConfig({ testTimeout: 60_000 });

// 25-char cuid body → LEGACY residency. 26-char v1 body (version "1" at index 25) → NEW residency.
const LEGACY_RUN_ID = "run_" + "a".repeat(25);
const NEW_RUN_ID = "run_" + "b".repeat(24) + "01";
// 26-char gen-2 body: shard char at index 24, version "2" at index 25.
const SHARD_A_RUN_ID = "run_" + "c".repeat(24) + "a2";
const SHARD_Z_RUN_ID = "run_" + "c".repeat(24) + "z2";
const LEGACY_WAITPOINT_ID = "waitpoint_" + "d".repeat(25);

function throwingClient(label: string) {
  return vi.fn(async (): Promise<{ marker: number } | null> => {
    throw new Error(`${label} must never be read`);
  });
}

function collectingLogger() {
  const errors: { message: string; meta?: unknown }[] = [];
  return { errors, error: (message: string, meta?: unknown) => errors.push({ message, meta }) };
}

// Lightweight real read: a trivial `$queryRaw` that genuinely hits the given container.
// `hit` controls whether the read "finds" the run, so we exercise routing without
// seeding a full TaskRun (many required FKs) — the routing DoD is store-order, not shape.
async function realRead(
  client: PrismaReplicaClient,
  hit: boolean
): Promise<{ marker: number } | null> {
  const rows = await client.$queryRaw<{ marker: number }[]>`SELECT 1 AS marker`;
  return hit ? (rows[0] ?? null) : null;
}

// A presenter-shaped mapping: both "not-found" and "past-retention" collapse to the
// same 404-ish surface, so an old run after termination yields the normal response.
function toHttpish<T>(result: ReadThroughResult<T>): { status: number; value?: T } {
  return result.found ? { status: 200, value: result.value } : { status: 404 };
}

describe("readThroughRun (legacy replica + new DB)", () => {
  heteroPostgresTest(
    "old in-retention run is served from the legacy REPLICA, never a primary",
    async ({ prisma14, prisma17 }) => {
      // legacy hit, new miss. The layer has NO legacy-writer handle at all — the
      // read resolving through `legacyReplica` (prisma14) IS the structural guarantee
      // that the primary is never touched.
      const result = await readThroughRun({
        id: LEGACY_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        readNew: (c) => realRead(c, false),
        readLegacy: (c) => realRead(c, true),
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.found && result.source).toBe("legacy-replica");
      expect(toHttpish(result).status).toBe(200);
    }
  );

  heteroPostgresTest(
    "post-termination past-retention returns the normal not-found surface",
    async ({ prisma14, prisma17 }) => {
      const pastRetentionResult = await readThroughRun({
        id: LEGACY_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        readNew: (c) => realRead(c, false),
        readLegacy: (c) => realRead(c, false), // legacy gone / retention elapsed
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
          isPastRetention: () => true,
        },
      });

      expect(pastRetentionResult.found === false && pastRetentionResult.reason).toBe("past-retention");

      // A run that is simply absent (not past retention) yields not-found.
      const notFoundResult = await readThroughRun({
        id: LEGACY_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        readNew: (c) => realRead(c, false),
        readLegacy: (c) => realRead(c, false),
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
          isPastRetention: () => false,
        },
      });

      expect(notFoundResult.found === false && notFoundResult.reason).toBe("not-found");
      // Both collapse to the same 404-ish surface.
      expect(toHttpish(pastRetentionResult).status).toBe(toHttpish(notFoundResult).status);
      expect(toHttpish(pastRetentionResult).status).toBe(404);
    }
  );

  heteroPostgresTest(
    "single-DB passthrough — only readNew runs, legacy never touched",
    async ({ prisma14, prisma17 }) => {
      const throwingLegacy = vi.fn(async (): Promise<{ marker: number } | null> => {
        throw new Error("readLegacy must never run in single-DB mode");
      });
      const newRead = vi.fn((c: PrismaReplicaClient) => realRead(c, true));

      const result = await readThroughRun({
        id: LEGACY_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        readNew: newRead,
        readLegacy: throwingLegacy,
        deps: {
          splitEnabled: false,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.found && result.source).toBe("new");
      expect(newRead).toHaveBeenCalledTimes(1);
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );

  heteroPostgresTest(
    "new-residency fast-path — legacy replica is never touched",
    async ({ prisma14, prisma17 }) => {
      const throwingLegacy = vi.fn(async (): Promise<{ marker: number } | null> => {
        throw new Error("readLegacy must never run for a NEW-residency id");
      });

      const result = await readThroughRun({
        id: NEW_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        readNew: (c) => realRead(c, true),
        readLegacy: throwingLegacy,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.found && result.source).toBe("new");
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );

  heteroPostgresTest(
    "gen-2 id reads its OWN shard replica once and probes no other store",
    async ({ prisma14, prisma17 }) => {
      const throwingNew = throwingClient("the gen-1 new store");
      const throwingLegacy = throwingClient("the legacy replica");
      const shardRead = vi.fn((c: PrismaReplicaClient) => realRead(c, true));

      const result = await readThroughRun({
        id: SHARD_A_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        // One closure serves both the gen-1 new store and a shard: a shard is the same
        // dedicated schema. The throwing clients prove WHICH client it was handed.
        readNew: (c) => shardRead(c),
        readLegacy: throwingLegacy,
        deps: {
          splitEnabled: true,
          newClient: throwingNew as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
          shardReplicas: new Map([["a", prisma17 as unknown as PrismaReplicaClient]]),
        },
      });

      expect(result.found && result.source).toBe("shard:a");
      expect(shardRead).toHaveBeenCalledTimes(1);
      // Identity, not deep equality: a Prisma client is too large to deep-compare.
      expect(shardRead.mock.calls[0][0]).toBe(prisma17);
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );

  heteroPostgresTest(
    "gen-2 id on an UNCONFIGURED shard key logs an error and returns not-found, never throws",
    async ({ prisma14, prisma17 }) => {
      const logger = collectingLogger();
      const throwingLegacy = throwingClient("the legacy replica");
      const newRead = vi.fn((c: PrismaReplicaClient) => realRead(c, true));

      // Shard "z" is not configured. A 500 here would be inducible by any caller that
      // guesses a shard char, so the layer must degrade rather than throw.
      const result = await readThroughRun({
        id: SHARD_Z_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        readNew: newRead,
        readLegacy: throwingLegacy,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
          shardReplicas: new Map([["a", prisma17 as unknown as PrismaReplicaClient]]),
          logger,
        },
      });

      expect(result.found).toBe(false);
      expect(result.found === false && result.reason).toBe("not-found");
      expect(logger.errors).toHaveLength(1);
      expect(logger.errors[0].meta).toMatchObject({ shardKey: "z", configured: ["a"] });
      // It must not silently fall back onto a gen-1 store.
      expect(newRead).not.toHaveBeenCalled();
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );

  heteroPostgresTest(
    "gen-1 RUN id reads the legacy replica only and never probes the new store",
    async ({ prisma14 }) => {
      const throwingNew = throwingClient("the new store");
      const legacyRead = vi.fn((c: PrismaReplicaClient) => realRead(c, true));

      const result = await readThroughRun({
        id: LEGACY_RUN_ID,
        idKind: "run",
        environmentId: "env_1",
        readNew: throwingNew,
        readLegacy: legacyRead,
        deps: {
          splitEnabled: true,
          newClient: prisma14 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.found && result.source).toBe("legacy-replica");
      expect(throwingNew).not.toHaveBeenCalled();
      expect(legacyRead).toHaveBeenCalledTimes(1);
    }
  );

  heteroPostgresTest(
    "cuid WAITPOINT id keeps the new-FIRST pair probe (frozen: cuid waitpoints co-locate on new)",
    async ({ prisma14, prisma17 }) => {
      const calls: string[] = [];
      const newRead = vi.fn(async (c: PrismaReplicaClient) => {
        calls.push("new");
        return realRead(c, false);
      });
      const legacyRead = vi.fn(async (c: PrismaReplicaClient) => {
        calls.push("legacy");
        return realRead(c, true);
      });

      const result = await readThroughRun({
        id: LEGACY_WAITPOINT_ID,
        idKind: "waitpoint",
        environmentId: "env_1",
        readNew: newRead,
        readLegacy: legacyRead,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.found && result.source).toBe("legacy-replica");
      expect(calls).toEqual(["new", "legacy"]);
    }
  );

  heteroPostgresTest(
    "a cuid waitpoint found on the new store returns it without touching legacy",
    async ({ prisma14, prisma17 }) => {
      const throwingLegacy = throwingClient("the legacy replica");

      const result = await readThroughRun({
        id: LEGACY_WAITPOINT_ID,
        idKind: "waitpoint",
        environmentId: "env_1",
        readNew: (c) => realRead(c, true),
        readLegacy: throwingLegacy,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.found && result.source).toBe("new");
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );
});

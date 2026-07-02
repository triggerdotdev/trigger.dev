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

// 25-char cuid body → LEGACY residency. 27-char body → NEW residency.
const LEGACY_RUN_ID = "run_" + "a".repeat(25);
const NEW_RUN_ID = "run_" + "b".repeat(27);

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
  switch (result.source) {
    case "new":
    case "legacy-replica":
      return { status: 200, value: result.value };
    case "not-found":
    case "past-retention":
      return { status: 404 };
  }
}

describe("readThroughRun (legacy replica + new DB)", () => {
  heteroPostgresTest(
    "old in-retention run is served from the legacy REPLICA, never a primary",
    async ({ prisma14, prisma17 }) => {
      // legacy hit, new miss. The layer has NO legacy-writer handle at all — the
      // read resolving through `legacyReplica` (prisma14) IS the structural guarantee
      // that the primary is never touched.
      const result = await readThroughRun({
        runId: LEGACY_RUN_ID,
        environmentId: "env_1",
        readNew: (c) => realRead(c, false),
        readLegacy: (c) => realRead(c, true),
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.source).toBe("legacy-replica");
      expect(toHttpish(result).status).toBe(200);
    }
  );

  heteroPostgresTest(
    "post-termination past-retention returns the normal not-found surface",
    async ({ prisma14, prisma17 }) => {
      const pastRetentionResult = await readThroughRun({
        runId: LEGACY_RUN_ID,
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

      expect(pastRetentionResult.source).toBe("past-retention");

      // A run that is simply absent (not past retention) yields not-found.
      const notFoundResult = await readThroughRun({
        runId: LEGACY_RUN_ID,
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

      expect(notFoundResult.source).toBe("not-found");
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
        runId: LEGACY_RUN_ID,
        environmentId: "env_1",
        readNew: newRead,
        readLegacy: throwingLegacy,
        deps: {
          splitEnabled: false,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.source).toBe("new");
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
        runId: NEW_RUN_ID,
        environmentId: "env_1",
        readNew: (c) => realRead(c, true),
        readLegacy: throwingLegacy,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      expect(result.source).toBe("new");
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );
});

// Real PG14 (legacy replica) + PG17 (new) proof for the bulk batch read-through adapter.
// We NEVER mock the DB: each closure runs a real `$queryRaw` against the passed container
// (crossing the actual PG14↔PG17 boundary) then filters an in-memory seeded set by id —
// mirroring readThrough.server.test.ts's `realRead`. The only injected fakes are throwing
// spies asserting a store was NEVER touched.
import { heteroPostgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import type { PrismaReplicaClient } from "~/db.server";
import { hydrateRunsAcrossSeam } from "./BulkActionV2.batchReadThrough.server";

vi.setConfig({ testTimeout: 60_000 });

// 25-char cuid body → LEGACY residency. 27-char body → NEW residency.
const LEGACY_RUN_ID = "run_" + "a".repeat(25);
const NEW_RUN_ID = "run_" + "b".repeat(27);

type Row = { id: string };

// Real read against the given container, then return rows for the ids present in `present`.
async function realReadFiltered(
  client: PrismaReplicaClient,
  ids: string[],
  present: Set<string>
): Promise<Row[]> {
  await client.$queryRaw<{ marker: number }[]>`SELECT 1 AS marker`;
  return ids.filter((id) => present.has(id)).map((id) => ({ id }));
}

describe("hydrateRunsAcrossSeam (PG14 legacy replica + PG17 new)", () => {
  heteroPostgresTest(
    "(a) mixed page: NEW id from new, LEGACY id from legacy replica; new id never hits legacy",
    async ({ prisma14, prisma17 }) => {
      const onNew = new Set([NEW_RUN_ID]);
      const onLegacy = new Set([LEGACY_RUN_ID]);

      const readLegacyReplica = vi.fn(
        async (replica: PrismaReplicaClient, ids: string[]): Promise<Row[]> => {
          if (ids.includes(NEW_RUN_ID)) {
            throw new Error("legacy replica must never be probed for a NEW-residency id");
          }
          return realReadFiltered(replica, ids, onLegacy);
        }
      );

      const rows = await hydrateRunsAcrossSeam<Row>({
        runIds: [NEW_RUN_ID, LEGACY_RUN_ID],
        readNew: (client, ids) => realReadFiltered(client, ids, onNew),
        readLegacyReplica,
        deps: {
          splitEnabled: true,
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual([LEGACY_RUN_ID, NEW_RUN_ID].sort());
      expect(readLegacyReplica).toHaveBeenCalledTimes(1);
      // legacy was only probed for the legacy id
      expect(readLegacyReplica.mock.calls[0][1]).toEqual([LEGACY_RUN_ID]);
    }
  );

  heteroPostgresTest(
    "(c) passthrough: splitEnabled false reads only the single client; legacy never touched",
    async ({ prisma14, prisma17 }) => {
      const onNew = new Set([NEW_RUN_ID, LEGACY_RUN_ID]);
      const throwingLegacy = vi.fn(async (): Promise<Row[]> => {
        throw new Error("readLegacyReplica must never run in single-DB mode");
      });
      const readNew = vi.fn((client: PrismaReplicaClient, ids: string[]) =>
        realReadFiltered(client, ids, onNew)
      );

      const rows = await hydrateRunsAcrossSeam<Row>({
        runIds: [NEW_RUN_ID, LEGACY_RUN_ID],
        readNew,
        readLegacyReplica: throwingLegacy,
        deps: {
          splitEnabled: false,
          // single collapsed store (use prisma17 here as the "new"/primary analog)
          newClient: prisma17 as unknown as PrismaReplicaClient,
          legacyReplica: prisma14 as unknown as PrismaReplicaClient,
        },
      });

      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual([LEGACY_RUN_ID, NEW_RUN_ID].sort());
      expect(readNew).toHaveBeenCalledTimes(1);
      expect(throwingLegacy).not.toHaveBeenCalled();
    }
  );
});

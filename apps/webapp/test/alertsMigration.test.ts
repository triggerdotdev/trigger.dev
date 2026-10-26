import { postgresTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import { applyAlertsMigration, replayAlertsMigration } from "./helpers/alertTables";

function monthSuffix(offset: number) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

describe("alerts_v1 migration", () => {
  postgresTest("creates month-partitioned AlertEvent and AlertDelivery", async ({ prisma }) => {
    await applyAlertsMigration(prisma);
    await replayAlertsMigration(prisma);

    const parents = await prisma.$queryRawUnsafe<Array<{ relname: string; partkey: string }>>(
      `SELECT c.relname, pg_get_partkeydef(c.oid) AS partkey
         FROM pg_class c
        WHERE c.relname IN ('AlertEvent', 'AlertDelivery') AND c.relkind = 'p'
        ORDER BY c.relname`
    );
    expect(parents).toEqual([
      { relname: "AlertDelivery", partkey: 'RANGE ("eventAt")' },
      { relname: "AlertEvent", partkey: "RANGE (at)" },
    ]);

    const pks = await prisma.$queryRawUnsafe<Array<{ table: string; def: string }>>(
      `SELECT conrelid::regclass::text AS table, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE contype = 'p' AND conrelid IN ('"AlertEvent"'::regclass, '"AlertDelivery"'::regclass)
        ORDER BY 1`
    );
    expect(pks).toEqual([
      { table: '"AlertDelivery"', def: 'PRIMARY KEY (id, "eventAt")' },
      { table: '"AlertEvent"', def: "PRIMARY KEY (id, at)" },
    ]);

    const children = await prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `SELECT c.relname
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent IN ('"AlertEvent"'::regclass, '"AlertDelivery"'::regclass)`
    );
    const names = children.map((r) => r.relname);
    for (const offset of [0, 1, 2]) {
      expect(names).toContain(`AlertEvent_p${monthSuffix(offset)}`);
      expect(names).toContain(`AlertDelivery_p${monthSuffix(offset)}`);
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO "AlertEvent" ("id", "alertId", "type") VALUES ('e1', 'a1', 'raised')`
    );
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "AlertEvent" ("id", "alertId", "type", "at") VALUES ('e2', 'a1', 'raised', '2000-01-15T00:00:00Z')`
      )
    ).rejects.toThrow(/no partition of relation "AlertEvent" found/);
  });
});

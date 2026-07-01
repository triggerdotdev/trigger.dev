import { heteroPostgresTest, HETERO_PINNED_ICU_COLLATION } from "@internal/testcontainers";
import { expect } from "vitest";

heteroPostgresTest(
  "byte-identity + identical ORDER-BY across PG14 and PG17",
  async ({ prisma14, prisma17, pinnedCollation }) => {
    expect(pinnedCollation).toBe(HETERO_PINNED_ICU_COLLATION);

    const rows = ["Émile", "emile", "Zoë", "zebra", "Ångström", "apple", "中文", "[1,2]"];
    const setup = async (p: typeof prisma14) => {
      await p.$executeRawUnsafe(`CREATE TABLE t (k text, j jsonb, a int[])`);
      for (const k of rows) {
        await p.$executeRawUnsafe(
          `INSERT INTO t (k, j, a) VALUES ($1, $2::jsonb, $3::int[])`,
          k,
          JSON.stringify({ v: k }),
          [1, 2, 3]
        );
      }
    };
    await setup(prisma14);
    await setup(prisma17);

    // Identical ORDER-BY keyset under the pinned ICU collation.
    const ordered = (p: typeof prisma14) =>
      p.$queryRawUnsafe<{ k: string }[]>(
        `SELECT k FROM t ORDER BY k COLLATE "${HETERO_PINNED_ICU_COLLATION}", k`
      );
    const o14 = await ordered(prisma14);
    const o17 = await ordered(prisma17);
    expect(o14.map((r) => r.k)).toEqual(o17.map((r) => r.k));

    // JSON + array byte-identity round-trip.
    const dump = (p: typeof prisma14) =>
      p.$queryRawUnsafe<{ j: unknown; a: number[] }[]>(
        `SELECT j, a FROM t ORDER BY k COLLATE "${HETERO_PINNED_ICU_COLLATION}", k`
      );
    expect(await dump(prisma14)).toEqual(await dump(prisma17));
  }
);

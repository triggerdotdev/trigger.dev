import { expect } from "vitest";
import { heteroRunOpsPostgresTest } from "./index.js";

// The dedicated subset (NEW/PG17) has run-ops tables (TaskRun) but NOT control-plane tables
// (Organization); the legacy side (PG14) keeps the full control-plane schema.
heteroRunOpsPostgresTest(
  "NEW (PG17) side has run-ops tables but NOT control-plane tables",
  async ({ prisma14, prisma17 }) => {
    // Cast regclass -> text: Prisma can't deserialize a bare `regclass` column.
    const regclass = async (
      p: { $queryRawUnsafe: (q: string) => Promise<unknown> },
      table: string
    ): Promise<string | null> => {
      const rows = (await p.$queryRawUnsafe(
        `SELECT to_regclass('"${table}"')::text AS t`
      )) as Array<{ t: string | null }>;
      return rows[0]?.t ?? null;
    };

    expect(await regclass(prisma14, "Organization")).not.toBeNull();
    expect(await regclass(prisma17, "TaskRun")).not.toBeNull();
    expect(await regclass(prisma17, "Organization")).toBeNull();
  },
  // Booting two PG containers and pushing two schemas on first run far exceeds vitest's 5s default.
  120_000
);

// The GLOBAL mint-kind flip must read -> stamp -> write the grace metadata in ONE transaction under
// an advisory lock, so concurrent global flips can't clobber each other's grace stamp (the per-org
// routes serialize the same way). NEVER mocks the DB: real testcontainers Postgres FeatureFlag rows.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { applyGlobalMintKindFlip, makeSetMultipleFlags } from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const MINT_KEYS = [
  FEATURE_FLAG.runOpsMintKind,
  FEATURE_FLAG.runOpsMintKindPrev,
  FEATURE_FLAG.runOpsMintKindFlippedAt,
];

async function readGlobalMint(prisma: PrismaClient): Promise<Record<string, unknown>> {
  const rows = await prisma.featureFlag.findMany({
    where: { key: { in: MINT_KEYS } },
    select: { key: true, value: true },
  });
  const m: Record<string, unknown> = {};
  for (const row of rows) m[row.key] = row.value;
  return m;
}

describe("applyGlobalMintKindFlip — transactional stamp + serialized flips", () => {
  postgresTest("a genuine global flip stamps prev + flippedAt", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintKind]: "cuid" });

    await applyGlobalMintKindFlip(prisma, { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" }, 60_000);

    const m = await readGlobalMint(prisma);
    expect(m[FEATURE_FLAG.runOpsMintKind]).toBe("runOpsId");
    expect(m[FEATURE_FLAG.runOpsMintKindPrev]).toBe("cuid");
    expect(typeof m[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBe("string");
  });

  postgresTest(
    "concurrent flips serialize and keep one coherent grace stamp",
    async ({ prisma }) => {
      await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintKind]: "cuid" });

      await Promise.all(
        Array.from({ length: 8 }, () =>
          applyGlobalMintKindFlip(prisma, { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" }, 60_000)
        )
      );

      // One genuine flip stamps prev=cuid + a flippedAt; same-target saves carry it forward. Under the
      // advisory lock the reads/writes serialize, so the stamp is a single coherent trio rather than an
      // interleaved partial write that drops prev/flippedAt.
      const m = await readGlobalMint(prisma);
      expect(m[FEATURE_FLAG.runOpsMintKind]).toBe("runOpsId");
      expect(m[FEATURE_FLAG.runOpsMintKindPrev]).toBe("cuid");
      expect(typeof m[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBe("string");
    }
  );
});

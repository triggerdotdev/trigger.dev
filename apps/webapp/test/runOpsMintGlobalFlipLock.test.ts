// The GLOBAL mint-kind flip must read -> stamp -> write the grace metadata in ONE transaction under
// an advisory lock, so concurrent global flips can't clobber each other's grace stamp (the per-org
// routes serialize the same way). NEVER mocks the DB: real testcontainers Postgres FeatureFlag rows.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { applyGlobalGracedFlips, makeSetMultipleFlags } from "~/v3/featureFlags.server";

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

describe("applyGlobalGracedFlips — transactional stamp + serialized flips", () => {
  postgresTest("a genuine global flip stamps prev + flippedAt", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintKind]: "cuid" });

    await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" }, 60_000);

    const m = await readGlobalMint(prisma);
    expect(m[FEATURE_FLAG.runOpsMintKind]).toBe("runOpsId");
    expect(m[FEATURE_FLAG.runOpsMintKindPrev]).toBe("cuid");
    expect(typeof m[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBe("string");
  });

  // Catches: the JSON writer setting the switch without its stamp, or a change to off recording off.
  postgresTest("a switch change stamps it, and a change to off records on", async ({ prisma }) => {
    const readSwitch = async () => {
      const rows = await prisma.featureFlag.findMany({
        where: {
          key: {
            in: [
              FEATURE_FLAG.runResidencyEnabled,
              FEATURE_FLAG.runResidencyEnabledPrev,
              FEATURE_FLAG.runResidencyEnabledFlippedAt,
            ],
          },
        },
        select: { key: true, value: true },
      });
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    };
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runResidencyEnabled]: false });

    await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runResidencyEnabled]: true }, 60_000);
    const on = await readSwitch();
    expect(on[FEATURE_FLAG.runResidencyEnabled]).toBe(true);
    expect(on[FEATURE_FLAG.runResidencyEnabledPrev]).toBe(false);
    expect(typeof on[FEATURE_FLAG.runResidencyEnabledFlippedAt]).toBe("string");

    await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runResidencyEnabled]: false }, 60_000);
    const off = await readSwitch();
    expect(off[FEATURE_FLAG.runResidencyEnabled]).toBe(false);
    expect(off[FEATURE_FLAG.runResidencyEnabledPrev]).toBe(true);
    expect(typeof off[FEATURE_FLAG.runResidencyEnabledFlippedAt]).toBe("string");
  });

  // Catches: the JSON writer treating an omitted switch as removed and stamping it.
  postgresTest(
    "a mint-kind-only save writes no stamps onto a stored on switch",
    async ({ prisma }) => {
      await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runResidencyEnabled]: true });

      await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" }, 60_000);

      const rows = await prisma.featureFlag.findMany({
        where: { key: { startsWith: FEATURE_FLAG.runResidencyEnabled } },
        select: { key: true, value: true },
      });
      expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toEqual({
        [FEATURE_FLAG.runResidencyEnabled]: true,
      });
    }
  );

  postgresTest(
    "concurrent flips serialize and keep one coherent grace stamp",
    async ({ prisma }) => {
      await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintKind]: "cuid" });

      await Promise.all(
        Array.from({ length: 8 }, () =>
          applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" }, 60_000)
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

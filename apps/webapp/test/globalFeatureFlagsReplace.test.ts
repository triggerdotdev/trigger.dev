// A runOpsMintKind change on the global admin flags page must go through the graced flip path
// (prev + flippedAt stamped), not a bare upsert. Real testcontainers Postgres, never mocked.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG, type FeatureFlagKey } from "~/v3/featureFlags";
import {
  makeSetMultipleFlags,
  replaceGlobalFeatureFlags,
} from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const MINT_KEYS: FeatureFlagKey[] = [
  FEATURE_FLAG.runOpsMintKind,
  FEATURE_FLAG.runOpsMintKindPrev,
  FEATURE_FLAG.runOpsMintKindFlippedAt,
];

// Mint trio + two ordinary boolean flags, to exercise the sweep alongside the carved-out mint keys.
const CATALOG_KEYS: FeatureFlagKey[] = [
  ...MINT_KEYS,
  FEATURE_FLAG.mollifierEnabled,
  FEATURE_FLAG.hasAiAccess,
];

const NEVER_PROTECTED = () => false;

async function readFlags(
  prisma: PrismaClient,
  keys: FeatureFlagKey[]
): Promise<Record<string, unknown>> {
  const rows = await prisma.featureFlag.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const m: Record<string, unknown> = {};
  for (const row of rows) m[row.key] = row.value;
  return m;
}

describe("replaceGlobalFeatureFlags — graces runOpsMintKind, preserves replace semantics", () => {
  postgresTest("a runOpsMintKind flip stamps prev + flippedAt (graced, not a bare upsert)", async ({
    prisma,
  }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintKind]: "cuid" });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, MINT_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintKind]).toBe("runOpsId");
    expect(m[FEATURE_FLAG.runOpsMintKindPrev]).toBe("cuid");
    expect(typeof m[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBe("string");
  });

  postgresTest("derived stamp fields supplied in the body are ignored (computed server-side)", async ({
    prisma,
  }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintKind]: "cuid" });

    await replaceGlobalFeatureFlags(prisma, {
      // Caller forges the stamp: prev="runOpsId", flippedAt=epoch. Both must be ignored.
      requestedFlags: {
        [FEATURE_FLAG.runOpsMintKind]: "runOpsId",
        [FEATURE_FLAG.runOpsMintKindPrev]: "runOpsId",
        [FEATURE_FLAG.runOpsMintKindFlippedAt]: "1970-01-01T00:00:00.000Z",
      },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, MINT_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintKindPrev]).toBe("cuid");
    expect(m[FEATURE_FLAG.runOpsMintKindFlippedAt]).not.toBe("1970-01-01T00:00:00.000Z");
  });

  postgresTest("re-applying the same runOpsMintKind does not reset the grace clock", async ({
    prisma,
  }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintKind]: "cuid" });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });
    const first = await readFlags(prisma, MINT_KEYS);

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });
    const second = await readFlags(prisma, MINT_KEYS);

    expect(second[FEATURE_FLAG.runOpsMintKind]).toBe("runOpsId");
    expect(second[FEATURE_FLAG.runOpsMintKindPrev]).toBe(first[FEATURE_FLAG.runOpsMintKindPrev]);
    expect(second[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBe(
      first[FEATURE_FLAG.runOpsMintKindFlippedAt]
    );
  });

  postgresTest("the mint trio survives a replace that omits runOpsMintKind (not swept)", async ({
    prisma,
  }) => {
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });
    const before = await readFlags(prisma, MINT_KEYS);

    // A later save that edits only an unrelated flag and omits the mint keys entirely.
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.mollifierEnabled]: true },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const after = await readFlags(prisma, MINT_KEYS);
    expect(after[FEATURE_FLAG.runOpsMintKind]).toBe("runOpsId");
    expect(after[FEATURE_FLAG.runOpsMintKindPrev]).toBe(before[FEATURE_FLAG.runOpsMintKindPrev]);
    expect(after[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBe(
      before[FEATURE_FLAG.runOpsMintKindFlippedAt]
    );
    const mollifier = await readFlags(prisma, [FEATURE_FLAG.mollifierEnabled]);
    expect(mollifier[FEATURE_FLAG.mollifierEnabled]).toBe(true);
  });

  postgresTest("non-mint flags keep replace semantics: submitted upserts, omitted deletes", async ({
    prisma,
  }) => {
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.mollifierEnabled]: true },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.hasAiAccess]: true },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, [FEATURE_FLAG.mollifierEnabled, FEATURE_FLAG.hasAiAccess]);
    expect(m[FEATURE_FLAG.hasAiAccess]).toBe(true);
    expect(m[FEATURE_FLAG.mollifierEnabled]).toBeUndefined();
  });

  postgresTest("protected omitted flags are not deleted", async ({ prisma }) => {
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.mollifierEnabled]: true },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    // A replace that omits mollifierEnabled but marks it protected must keep it.
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.hasAiAccess]: true },
      catalogKeys: CATALOG_KEYS,
      isProtected: (key) => key === FEATURE_FLAG.mollifierEnabled,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, [FEATURE_FLAG.mollifierEnabled]);
    expect(m[FEATURE_FLAG.mollifierEnabled]).toBe(true);
  });
});

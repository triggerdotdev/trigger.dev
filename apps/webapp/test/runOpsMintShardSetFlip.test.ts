// The active mint-shard list lives in the control-plane database, not in the environment: a
// rolling deploy runs two environment values at once for hours, so only a shared row lets every
// pod agree on one list. A change must therefore read -> stamp -> write under an advisory lock,
// and must never be writable as a bare upsert from a request body. Real testcontainers Postgres.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG, type FeatureFlagKey } from "~/v3/featureFlags";
import {
  applyGlobalGracedFlips,
  makeSetMultipleFlags,
  replaceGlobalFeatureFlags,
} from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const SET_KEYS: FeatureFlagKey[] = [
  FEATURE_FLAG.runOpsMintShardSet,
  FEATURE_FLAG.runOpsMintShardSetPrev,
  FEATURE_FLAG.runOpsMintShardSetFlippedAt,
];

const MINT_KIND_KEYS: FeatureFlagKey[] = [
  FEATURE_FLAG.runOpsMintKind,
  FEATURE_FLAG.runOpsMintKindPrev,
  FEATURE_FLAG.runOpsMintKindFlippedAt,
];

const CATALOG_KEYS: FeatureFlagKey[] = [
  ...SET_KEYS,
  ...MINT_KIND_KEYS,
  FEATURE_FLAG.mollifierEnabled,
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

describe("applyGlobalGracedFlips — the shard-set list is stamped, not bare-written", () => {
  postgresTest("a genuine list change stamps prev + flippedAt", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintShardSet]: "a" });

    await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintShardSet]: "a,b" }, 60_000);

    const m = await readFlags(prisma, SET_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintShardSet]).toBe("a,b");
    expect(m[FEATURE_FLAG.runOpsMintShardSetPrev]).toBe("a");
    expect(typeof m[FEATURE_FLAG.runOpsMintShardSetFlippedAt]).toBe("string");
  });

  postgresTest("a first activation stamps an empty prev, which graces it", async ({ prisma }) => {
    await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintShardSet]: "a" }, 60_000);

    const m = await readFlags(prisma, SET_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintShardSetPrev]).toBe("");
    expect(typeof m[FEATURE_FLAG.runOpsMintShardSetFlippedAt]).toBe("string");
  });

  postgresTest(
    "a reordered list is not a change, so the clock is not reset",
    async ({ prisma }) => {
      await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintShardSet]: "a,b" }, 60_000);
      const first = await readFlags(prisma, SET_KEYS);

      await applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintShardSet]: "b,a" }, 60_000);
      const second = await readFlags(prisma, SET_KEYS);

      expect(second[FEATURE_FLAG.runOpsMintShardSetFlippedAt]).toBe(
        first[FEATURE_FLAG.runOpsMintShardSetFlippedAt]
      );
    }
  );

  postgresTest("both graced groups stamp in ONE save", async ({ prisma }) => {
    // A save that flips the kind and the list must not stamp one and lose the other.
    await makeSetMultipleFlags(prisma)({
      [FEATURE_FLAG.runOpsMintKind]: "cuid",
      [FEATURE_FLAG.runOpsMintShardSet]: "a",
    });

    await applyGlobalGracedFlips(
      prisma,
      {
        [FEATURE_FLAG.runOpsMintKind]: "runOpsId",
        [FEATURE_FLAG.runOpsMintShardSet]: "a,b",
      },
      60_000
    );

    const m = await readFlags(prisma, [...SET_KEYS, ...MINT_KIND_KEYS]);
    expect(m[FEATURE_FLAG.runOpsMintKindPrev]).toBe("cuid");
    expect(m[FEATURE_FLAG.runOpsMintShardSetPrev]).toBe("a");
    expect(typeof m[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBe("string");
    expect(typeof m[FEATURE_FLAG.runOpsMintShardSetFlippedAt]).toBe("string");
  });

  postgresTest("concurrent list changes serialize on the lock", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintShardSet]: "a" });

    await Promise.all([
      applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintShardSet]: "a,b" }, 60_000),
      applyGlobalGracedFlips(prisma, { [FEATURE_FLAG.runOpsMintShardSet]: "a,c" }, 60_000),
    ]);

    const m = await readFlags(prisma, SET_KEYS);
    // Whichever won, the stamp must describe a real predecessor, never be absent.
    expect(["a", "a,b", "a,c"]).toContain(m[FEATURE_FLAG.runOpsMintShardSetPrev]);
    expect(typeof m[FEATURE_FLAG.runOpsMintShardSetFlippedAt]).toBe("string");
  });
});

describe("replaceGlobalFeatureFlags — the admin page cannot bypass the stamp", () => {
  postgresTest("a list change through the page is stamped", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintShardSet]: "a" });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintShardSet]: "a,b" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, SET_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintShardSet]).toBe("a,b");
    expect(m[FEATURE_FLAG.runOpsMintShardSetPrev]).toBe("a");
  });

  postgresTest("a body-supplied stamp is ignored and recomputed", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.runOpsMintShardSet]: "a" });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: {
        [FEATURE_FLAG.runOpsMintShardSet]: "a,b",
        [FEATURE_FLAG.runOpsMintShardSetPrev]: "zzz",
        [FEATURE_FLAG.runOpsMintShardSetFlippedAt]: "1999-01-01T00:00:00.000Z",
      },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, SET_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintShardSetPrev]).toBe("a");
    expect(m[FEATURE_FLAG.runOpsMintShardSetFlippedAt]).not.toBe("1999-01-01T00:00:00.000Z");
  });

  postgresTest("the set trio survives a save that omits the set keys", async ({ prisma }) => {
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintShardSet]: "a,b" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.mollifierEnabled]: true },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, SET_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintShardSet]).toBe("a,b");
  });

  postgresTest(
    "omitting the list DELETES it, so unset still turns minting off",
    async ({ prisma }) => {
      // The admin page's unset button omits the key. If the save skipped it, unset would be a
      // silent no-op and gen-2 minting would stay armed.
      await replaceGlobalFeatureFlags(prisma, {
        requestedFlags: { [FEATURE_FLAG.runOpsMintShardSet]: "a,b" },
        catalogKeys: CATALOG_KEYS,
        isProtected: NEVER_PROTECTED,
        graceMs: 60_000,
      });

      await replaceGlobalFeatureFlags(prisma, {
        requestedFlags: {},
        catalogKeys: CATALOG_KEYS,
        isProtected: NEVER_PROTECTED,
        graceMs: 60_000,
      });

      const m = await readFlags(prisma, SET_KEYS);
      // The stamp goes with it: a stamp without its list keeps being served for the whole window.
      expect(m[FEATURE_FLAG.runOpsMintShardSet]).toBeUndefined();
      expect(m[FEATURE_FLAG.runOpsMintShardSetPrev]).toBeUndefined();
      expect(m[FEATURE_FLAG.runOpsMintShardSetFlippedAt]).toBeUndefined();
    }
  );

  postgresTest("omitting the mint kind still deletes its trio", async ({ prisma }) => {
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintKind]: "runOpsId" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: {},
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, MINT_KIND_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintKind]).toBeUndefined();
    expect(m[FEATURE_FLAG.runOpsMintKindPrev]).toBeUndefined();
    expect(m[FEATURE_FLAG.runOpsMintKindFlippedAt]).toBeUndefined();
  });

  postgresTest("a protected list is not deleted when omitted", async ({ prisma }) => {
    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.runOpsMintShardSet]: "a" },
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: {},
      catalogKeys: CATALOG_KEYS,
      isProtected: (key) => key === FEATURE_FLAG.runOpsMintShardSet,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, SET_KEYS);
    expect(m[FEATURE_FLAG.runOpsMintShardSet]).toBe("a");
  });

  postgresTest("an ordinary flag keeps replace semantics", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.mollifierEnabled]: true });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: {},
      catalogKeys: CATALOG_KEYS,
      isProtected: NEVER_PROTECTED,
      graceMs: 60_000,
    });

    const m = await readFlags(prisma, [FEATURE_FLAG.mollifierEnabled]);
    expect(m[FEATURE_FLAG.mollifierEnabled]).toBeUndefined();
  });
});

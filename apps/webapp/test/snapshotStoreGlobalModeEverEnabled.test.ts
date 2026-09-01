// The global one-way "mode ever non-off" latch. It records whether the global dial has ever been
// past `off`, so a per-org transition-skip can tell a never-enabled org from one that saw a
// global-era birth. One-way: set on the first non-off save, never cleared, never deleted by the
// replace-semantics sweep. NEVER mocks the DB: real testcontainers Postgres FeatureFlag rows.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import {
  FEATURE_FLAG,
  FeatureFlagCatalog,
  stampSnapshotStoreGlobalModeEverEnabled,
  withoutOrgForbiddenSnapshotKeys,
  type FeatureFlagKey,
} from "~/v3/featureFlags";
import {
  makeSetMultipleFlags,
  replaceGlobalFeatureFlags,
  setGlobalFeatureFlagsTransactional,
  stampGlobalModeLatchForMerge,
} from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const MODE = FEATURE_FLAG.snapshotStoreMode;
const LATCH = FEATURE_FLAG.snapshotStoreGlobalModeEverEnabled;
const CATALOG_KEYS = Object.keys(FeatureFlagCatalog) as FeatureFlagKey[];

async function readFlag(prisma: PrismaClient, key: FeatureFlagKey): Promise<unknown> {
  const row = await prisma.featureFlag.findFirst({ where: { key }, select: { value: true } });
  return row?.value;
}

function replace(
  prisma: PrismaClient,
  requestedFlags: Record<string, unknown>,
  opts?: { unlockLockedFlags?: boolean; isManagedCloud?: boolean }
) {
  return replaceGlobalFeatureFlags(prisma, {
    requestedFlags,
    catalogKeys: CATALOG_KEYS,
    isManagedCloud: opts?.isManagedCloud ?? false,
    unlockLockedFlags: opts?.unlockLockedFlags ?? false,
    graceMs: 0,
  });
}

describe("stampSnapshotStoreGlobalModeEverEnabled (pure one-way latch)", () => {
  it("latches true when the resulting dial moves past off", () => {
    for (const mode of ["dual-write", "redis-read", "redis-only"]) {
      const stamped = stampSnapshotStoreGlobalModeEverEnabled(null, { [MODE]: mode });
      expect(stamped[LATCH], mode).toBe(true);
    }
  });

  it("keeps the latch true when the dial is set back to off (one-way)", () => {
    const stamped = stampSnapshotStoreGlobalModeEverEnabled({ [LATCH]: true }, { [MODE]: "off" });
    expect(stamped[LATCH]).toBe(true);
  });

  it("carries an existing latch forward on a save that omits the dial", () => {
    const stamped = stampSnapshotStoreGlobalModeEverEnabled({ [LATCH]: true }, { someOther: "x" });
    expect(stamped[LATCH]).toBe(true);
  });

  it("leaves the latch absent (never false) when off and never enabled", () => {
    const stamped = stampSnapshotStoreGlobalModeEverEnabled(null, { [MODE]: "off" });
    expect(LATCH in stamped).toBe(false);
  });

  it("is stripped from an operator-supplied org save payload", () => {
    expect(
      withoutOrgForbiddenSnapshotKeys({ [LATCH]: false, [FEATURE_FLAG.mollifierEnabled]: true })
    ).toEqual({ [FEATURE_FLAG.mollifierEnabled]: true });
  });
});

describe("replaceGlobalFeatureFlags — global mode latch (replace semantics)", () => {
  postgresTest("stamps the latch true when the dial is saved to dual-write", async ({ prisma }) => {
    await replace(prisma, { [MODE]: "dual-write" });
    expect(await readFlag(prisma, LATCH)).toBe(true);
  });

  postgresTest("redis-read and redis-only also stamp the latch", async ({ prisma }) => {
    for (const mode of ["redis-read", "redis-only"]) {
      await replace(prisma, { [MODE]: mode });
      expect(await readFlag(prisma, LATCH), mode).toBe(true);
      await prisma.featureFlag.deleteMany({ where: { key: { in: [LATCH, MODE] } } });
    }
  });

  postgresTest(
    "keeps the latch when a later save sets the dial back to off",
    async ({ prisma }) => {
      await replace(prisma, { [MODE]: "dual-write" });
      await replace(prisma, { [MODE]: "off" });
      expect(await readFlag(prisma, MODE)).toBe("off");
      expect(await readFlag(prisma, LATCH)).toBe(true);
    }
  );

  postgresTest("does not stamp the latch when off and never enabled", async ({ prisma }) => {
    await replace(prisma, { [MODE]: "off" });
    expect(await readFlag(prisma, LATCH)).toBeUndefined();
  });

  postgresTest("keeps the latch even on a self-hosted unlock that omits it", async ({ prisma }) => {
    await replace(prisma, { [MODE]: "dual-write" });
    // Unlock + omit the latch: without protection the replace-sweep would delete it.
    await replace(prisma, {}, { unlockLockedFlags: true });
    expect(await readFlag(prisma, LATCH)).toBe(true);
  });

  postgresTest("never writes a false latch from an operator-supplied value", async ({ prisma }) => {
    // A self-hosted unlock is the only way the latch key reaches the payload; it must not win.
    await replace(prisma, { [LATCH]: false, [MODE]: "off" }, { unlockLockedFlags: true });
    expect(await readFlag(prisma, LATCH)).toBeUndefined();
  });
});

describe("stampGlobalModeLatchForMerge — JSON admin API (merge semantics)", () => {
  postgresTest("stamps the latch true when enabling via merge", async ({ prisma }) => {
    const stamped = await stampGlobalModeLatchForMerge(prisma, { [MODE]: "dual-write" });
    expect(stamped[LATCH]).toBe(true);
  });

  postgresTest("carries a stored latch forward on a save back to off", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [LATCH]: true });
    const stamped = await stampGlobalModeLatchForMerge(prisma, { [MODE]: "off" });
    expect(stamped[LATCH]).toBe(true);
  });

  postgresTest("does not stamp when off and no stored latch", async ({ prisma }) => {
    const stamped = await stampGlobalModeLatchForMerge(prisma, { [MODE]: "off" });
    expect(LATCH in stamped).toBe(false);
  });

  postgresTest("orders the latch before the mode for a crash-safe write", async ({ prisma }) => {
    // makeSetMultipleFlags upserts in insertion order, so the latch must come first: a crash mid-write
    // then leaves latch=true with the mode possibly still off, never mode=non-off + latch absent.
    const stamped = await stampGlobalModeLatchForMerge(prisma, { [MODE]: "dual-write" });
    const keys = Object.keys(stamped);
    expect(keys.indexOf(LATCH)).toBe(0);
    expect(keys.indexOf(LATCH)).toBeLessThan(keys.indexOf(MODE));
  });

  postgresTest("transactional write lands both the mode and the latch", async ({ prisma }) => {
    const stamped = await stampGlobalModeLatchForMerge(prisma, { [MODE]: "dual-write" });
    await setGlobalFeatureFlagsTransactional(prisma, stamped);
    expect(await readFlag(prisma, MODE)).toBe("dual-write");
    expect(await readFlag(prisma, LATCH)).toBe(true);
  });
});

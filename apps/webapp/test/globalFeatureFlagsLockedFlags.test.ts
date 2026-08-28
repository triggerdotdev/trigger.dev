// With "Unlock read-only flags" off, the page strips GLOBAL_LOCKED_FLAGS from its payload, so an
// omitted locked key means "the UI never offered it", not "the admin unset it".
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG, FeatureFlagCatalog, type FeatureFlagKey } from "~/v3/featureFlags";
import { makeSetMultipleFlags, replaceGlobalFeatureFlags } from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const CATALOG_KEYS = Object.keys(FeatureFlagCatalog) as FeatureFlagKey[];
const WORKER_GROUP_ID = "clwg000000000000000000000";

async function readFlag(prisma: PrismaClient, key: FeatureFlagKey): Promise<unknown> {
  const row = await prisma.featureFlag.findFirst({ where: { key }, select: { value: true } });
  return row?.value;
}

describe("replaceGlobalFeatureFlags — locked flags the UI never submitted", () => {
  postgresTest(
    "keeps defaultWorkerInstanceGroupId when a locked flag is absent from the payload",
    async ({ prisma }) => {
      await makeSetMultipleFlags(prisma)({
        [FEATURE_FLAG.defaultWorkerInstanceGroupId]: WORKER_GROUP_ID,
        [FEATURE_FLAG.mollifierEnabled]: true,
      });

      // What the page posts when an admin unsets mollifierEnabled on a self-hosted instance.
      await replaceGlobalFeatureFlags(prisma, {
        requestedFlags: {},
        catalogKeys: CATALOG_KEYS,
        isManagedCloud: false,
        unlockLockedFlags: false,
      });

      expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(
        WORKER_GROUP_ID
      );
      expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBeUndefined();
    }
  );

  postgresTest("an unlocked self-hosted page can still unset a locked flag", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({
      [FEATURE_FLAG.defaultWorkerInstanceGroupId]: WORKER_GROUP_ID,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: {},
      catalogKeys: CATALOG_KEYS,
      isManagedCloud: false,
      unlockLockedFlags: true,
    });

    expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBeUndefined();
  });

  postgresTest(
    "managed cloud keeps locked flags even when unlocking is claimed",
    async ({ prisma }) => {
      await makeSetMultipleFlags(prisma)({
        [FEATURE_FLAG.defaultWorkerInstanceGroupId]: WORKER_GROUP_ID,
      });

      await replaceGlobalFeatureFlags(prisma, {
        requestedFlags: {},
        catalogKeys: CATALOG_KEYS,
        isManagedCloud: true,
        unlockLockedFlags: true,
      });

      expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(
        WORKER_GROUP_ID
      );
    }
  );

  postgresTest("managed cloud still sweeps ordinary flags it was not sent", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({
      [FEATURE_FLAG.defaultWorkerInstanceGroupId]: WORKER_GROUP_ID,
      [FEATURE_FLAG.hasAiAccess]: true,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.mollifierEnabled]: true },
      catalogKeys: CATALOG_KEYS,
      isManagedCloud: true,
      unlockLockedFlags: false,
    });

    expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBe(WORKER_GROUP_ID);
    expect(await readFlag(prisma, FEATURE_FLAG.hasAiAccess)).toBeUndefined();
    expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBe(true);
  });

  // The upsert and the sweep share one statement, which is only safe while no key is in both.
  postgresTest("a submitted key is never also swept", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({
      [FEATURE_FLAG.mollifierEnabled]: true,
      [FEATURE_FLAG.hasAiAccess]: true,
      [FEATURE_FLAG.defaultWorkerInstanceGroupId]: WORKER_GROUP_ID,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: {
        [FEATURE_FLAG.mollifierEnabled]: false,
        [FEATURE_FLAG.hasAiAccess]: true,
      },
      catalogKeys: CATALOG_KEYS,
      isManagedCloud: false,
      unlockLockedFlags: true,
    });

    // Both submitted keys survive with their new values rather than being swept by the same
    // statement that wrote them.
    expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBe(false);
    expect(await readFlag(prisma, FEATURE_FLAG.hasAiAccess)).toBe(true);
    expect(await readFlag(prisma, FEATURE_FLAG.defaultWorkerInstanceGroupId)).toBeUndefined();
  });

  postgresTest("writes nothing when there is nothing to write", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({ [FEATURE_FLAG.mollifierEnabled]: true });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: {},
      catalogKeys: [],
      isManagedCloud: false,
      unlockLockedFlags: false,
    });

    expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBe(true);
  });

  postgresTest("submitted flags are upserted and omitted ones swept", async ({ prisma }) => {
    await makeSetMultipleFlags(prisma)({
      [FEATURE_FLAG.mollifierEnabled]: true,
      [FEATURE_FLAG.hasAiAccess]: true,
    });

    await replaceGlobalFeatureFlags(prisma, {
      requestedFlags: { [FEATURE_FLAG.mollifierEnabled]: false },
      catalogKeys: CATALOG_KEYS,
      isManagedCloud: false,
      unlockLockedFlags: false,
    });

    expect(await readFlag(prisma, FEATURE_FLAG.mollifierEnabled)).toBe(false);
    expect(await readFlag(prisma, FEATURE_FLAG.hasAiAccess)).toBeUndefined();
  });
});

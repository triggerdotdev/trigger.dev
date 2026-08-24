// replaceGlobalFeatureFlags writes through hand-built SQL rather than Prisma's typed upsert, so
// every control type in the catalog has to land in the column exactly as the typed write would.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { FEATURE_FLAG, FeatureFlagCatalog, type FeatureFlagKey } from "~/v3/featureFlags";
import { makeSetMultipleFlags, replaceGlobalFeatureFlags } from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const CATALOG_KEYS = Object.keys(FeatureFlagCatalog) as FeatureFlagKey[];

const CASES: { key: FeatureFlagKey; value: unknown; label: string }[] = [
  { key: FEATURE_FLAG.defaultWorkerInstanceGroupId, value: "clwg0001", label: "string" },
  { key: FEATURE_FLAG.mollifierEnabled, value: true, label: "boolean true" },
  { key: FEATURE_FLAG.hasAiAccess, value: false, label: "boolean false" },
  { key: FEATURE_FLAG.computeMigrationFreePercentage, value: 0, label: "number zero" },
  { key: FEATURE_FLAG.computeMigrationPaidPercentage, value: 100, label: "number" },
  { key: FEATURE_FLAG.realtimeBackend, value: "shadow", label: "enum" },
  {
    key: FEATURE_FLAG.promotedDashboardAgentPrompt,
    value: '{"prompt":"hi","nested":{"quote":"a \\"quoted\\" word"}}',
    label: "string holding JSON",
  },
];

async function raw(prisma: PrismaClient, key: FeatureFlagKey) {
  const row = await prisma.featureFlag.findFirst({ where: { key }, select: { value: true } });
  return row?.value;
}

describe("replaceGlobalFeatureFlags value fidelity", () => {
  for (const { key, value, label } of CASES) {
    postgresTest(`${label} matches the typed write`, async ({ prisma }) => {
      await replaceGlobalFeatureFlags(prisma, {
        requestedFlags: { [key]: value },
        catalogKeys: CATALOG_KEYS,
        isManagedCloud: false,
        unlockLockedFlags: true,
      });
      const viaRawSql = await raw(prisma, key);

      await prisma.featureFlag.deleteMany({ where: { key } });
      await makeSetMultipleFlags(prisma)({ [key]: value } as any);
      const viaPrisma = await raw(prisma, key);

      expect(viaRawSql).toStrictEqual(viaPrisma);
      expect(viaRawSql).toStrictEqual(value);
    });
  }
});

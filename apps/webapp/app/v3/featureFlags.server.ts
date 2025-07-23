import { z } from "zod";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";

export const FEATURE_FLAG = {
  defaultWorkerInstanceGroupId: "defaultWorkerInstanceGroupId",
  runsListRepository: "runsListRepository",
} as const;

const FeatureFlagCatalog = {
  [FEATURE_FLAG.defaultWorkerInstanceGroupId]: z.string(),
  [FEATURE_FLAG.runsListRepository]: z.enum(["clickhouse", "postgres"]),
};

type FeatureFlagKey = keyof typeof FeatureFlagCatalog;

export type FlagsOptions<T extends FeatureFlagKey> = {
  key: T;
  defaultValue?: z.infer<(typeof FeatureFlagCatalog)[T]>;
};

export function makeFlags(_prisma: PrismaClientOrTransaction = prisma) {
  function flags<T extends FeatureFlagKey>(
    opts: FlagsOptions<T> & { defaultValue: z.infer<(typeof FeatureFlagCatalog)[T]> }
  ): Promise<z.infer<(typeof FeatureFlagCatalog)[T]>>;
  function flags<T extends FeatureFlagKey>(
    opts: FlagsOptions<T>
  ): Promise<z.infer<(typeof FeatureFlagCatalog)[T]> | undefined>;
  async function flags<T extends FeatureFlagKey>(
    opts: FlagsOptions<T>
  ): Promise<z.infer<(typeof FeatureFlagCatalog)[T]> | undefined> {
    const value = await _prisma.featureFlag.findUnique({
      where: {
        key: opts.key,
      },
    });

    const parsed = FeatureFlagCatalog[opts.key].safeParse(value?.value);

    if (!parsed.success) {
      return opts.defaultValue;
    }

    return parsed.data;
  }

  return flags;
}

export function makeSetFlags(_prisma: PrismaClientOrTransaction = prisma) {
  return async function setFlags<T extends FeatureFlagKey>(
    opts: FlagsOptions<T> & { value: z.infer<(typeof FeatureFlagCatalog)[T]> }
  ): Promise<void> {
    await _prisma.featureFlag.upsert({
      where: {
        key: opts.key,
      },
      create: {
        key: opts.key,
        value: opts.value,
      },
      update: {
        value: opts.value,
      },
    });
  };
}

export const flags = makeFlags();
export const setFlags = makeSetFlags();

// Create a Zod schema from the existing catalog
export const FeatureFlagCatalogSchema = z.object(FeatureFlagCatalog);

// Utility function to validate a feature flag value
export function validateFeatureFlagValue<T extends FeatureFlagKey>(
  key: T,
  value: unknown
): z.SafeParseReturnType<unknown, z.infer<(typeof FeatureFlagCatalog)[T]>> {
  return FeatureFlagCatalog[key].safeParse(value);
}

// Utility function to validate all feature flags at once
export function validateAllFeatureFlags(values: Record<string, unknown>) {
  return FeatureFlagCatalogSchema.safeParse(values);
}

// Utility function to validate partial feature flags (all keys optional)
export function validatePartialFeatureFlags(values: Record<string, unknown>) {
  return FeatureFlagCatalogSchema.partial().safeParse(values);
}

// Utility function to set multiple feature flags at once
export function makeSetMultipleFlags(_prisma: PrismaClientOrTransaction = prisma) {
  return async function setMultipleFlags(
    flags: Partial<z.infer<typeof FeatureFlagCatalogSchema>>
  ): Promise<{ key: string; value: any }[]> {
    const setFlag = makeSetFlags(_prisma);
    const updatedFlags: { key: string; value: any }[] = [];

    for (const [key, value] of Object.entries(flags)) {
      if (value !== undefined) {
        await setFlag({
          key: key as any,
          value: value as any,
        });
        updatedFlags.push({ key, value });
      }
    }

    return updatedFlags;
  };
}

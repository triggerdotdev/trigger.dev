import { type z } from "zod";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import {
  type FeatureFlagKey,
  FeatureFlagCatalog,
  FeatureFlagCatalogSchema,
} from "~/v3/featureFlags";

export type FlagsOptions<T extends FeatureFlagKey> = {
  key: T;
  defaultValue?: z.infer<(typeof FeatureFlagCatalog)[T]>;
  overrides?: Record<string, unknown>;
};

export function makeFlag(_prisma: PrismaClientOrTransaction = prisma) {
  function flag<T extends FeatureFlagKey>(
    opts: FlagsOptions<T> & { defaultValue: z.infer<(typeof FeatureFlagCatalog)[T]> }
  ): Promise<z.infer<(typeof FeatureFlagCatalog)[T]>>;
  function flag<T extends FeatureFlagKey>(
    opts: FlagsOptions<T>
  ): Promise<z.infer<(typeof FeatureFlagCatalog)[T]> | undefined>;
  async function flag<T extends FeatureFlagKey>(
    opts: FlagsOptions<T>
  ): Promise<z.infer<(typeof FeatureFlagCatalog)[T]> | undefined> {
    const value = await _prisma.featureFlag.findFirst({
      where: {
        key: opts.key,
      },
    });

    const flagSchema = FeatureFlagCatalog[opts.key];

    if (opts.overrides?.[opts.key] !== undefined) {
      const parsed = flagSchema.safeParse(opts.overrides[opts.key]);

      if (parsed.success) {
        return parsed.data;
      }
    }

    if (value !== null) {
      const parsed = flagSchema.safeParse(value.value);

      if (parsed.success) {
        return parsed.data;
      }
    }

    return opts.defaultValue;
  }

  return flag;
}

export function makeSetFlag(_prisma: PrismaClientOrTransaction = prisma) {
  return async function setFlag<T extends FeatureFlagKey>(
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

export type AllFlagsOptions = {
  defaultValues?: Partial<FeatureFlagCatalog>;
  overrides?: Record<string, unknown>;
};

export function makeFlags(_prisma: PrismaClientOrTransaction = prisma) {
  return async function flags(options?: AllFlagsOptions): Promise<Partial<FeatureFlagCatalog>> {
    const rows = await _prisma.featureFlag.findMany();

    // Build a map of key -> value from database
    const dbValues = new Map<string, unknown>();
    for (const row of rows) {
      dbValues.set(row.key, row.value);
    }

    const result: Partial<FeatureFlagCatalog> = {};

    // Process each flag in the catalog
    for (const key of Object.keys(FeatureFlagCatalog) as FeatureFlagKey[]) {
      const schema = FeatureFlagCatalog[key];

      // Priority: overrides > database > defaultValues
      if (options?.overrides?.[key] !== undefined) {
        const parsed = schema.safeParse(options.overrides[key]);
        if (parsed.success) {
          (result as any)[key] = parsed.data;
          continue;
        }
      }

      if (dbValues.has(key)) {
        const parsed = schema.safeParse(dbValues.get(key));
        if (parsed.success) {
          (result as any)[key] = parsed.data;
          continue;
        }
      }

      if (options?.defaultValues?.[key] !== undefined) {
        const parsed = schema.safeParse(options.defaultValues[key]);
        if (parsed.success) {
          (result as any)[key] = parsed.data;
        }
      }
    }

    return result;
  };
}

export const flag = makeFlag();
export const flags = makeFlags();
export const setFlag = makeSetFlag();

// Utility function to set multiple feature flags at once
export function makeSetMultipleFlags(_prisma: PrismaClientOrTransaction = prisma) {
  return async function setMultipleFlags(
    flags: Partial<z.infer<typeof FeatureFlagCatalogSchema>>
  ): Promise<{ key: string; value: any }[]> {
    const setFlag = makeSetFlag(_prisma);
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

import { z } from "zod";
import { prisma, PrismaClientOrTransaction } from "~/db.server";

export const FEATURE_FLAG = {
  defaultWorkerInstanceGroupId: "defaultWorkerInstanceGroupId",
} as const;

const FeatureFlagCatalog = {
  [FEATURE_FLAG.defaultWorkerInstanceGroupId]: z.string(),
};

type FeatureFlagKey = keyof typeof FeatureFlagCatalog;

export type FlagsOptions = {
  key: FeatureFlagKey;
};

export function makeFlags(_prisma: PrismaClientOrTransaction = prisma) {
  return async function flags<T extends FeatureFlagKey>(
    opts: FlagsOptions
  ): Promise<z.infer<(typeof FeatureFlagCatalog)[T]> | undefined> {
    const value = await _prisma.featureFlag.findUnique({
      where: {
        key: opts.key,
      },
    });

    const parsed = FeatureFlagCatalog[opts.key].safeParse(value?.value);

    if (!parsed.success) {
      return;
    }

    return parsed.data;
  };
}

export function makeSetFlags(_prisma: PrismaClientOrTransaction = prisma) {
  return async function setFlags<T extends FeatureFlagKey>(
    opts: FlagsOptions & { value: z.infer<(typeof FeatureFlagCatalog)[T]> }
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

import { type z } from "zod";
import type { PrismaClient } from "@trigger.dev/database";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import {
  FEATURE_FLAG,
  type FeatureFlagCatalogSchema,
  type FeatureFlagKey,
  FeatureFlagCatalog,
} from "~/v3/featureFlags";
import { stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";
import { stampMintShardSetFlip } from "~/v3/runOpsMigration/mintShardGrace";
import { boundedIn } from "~/db.server";

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
    const flagSchema = FeatureFlagCatalog[opts.key];

    const override = opts.overrides?.[opts.key];

    if (override !== undefined) {
      const parsed = flagSchema.safeParse(override);

      if (parsed.success) {
        return parsed.data;
      }

      // an override that fails the schema is ignored: the global value still wins
    }

    const value = await _prisma.featureFlag.findFirst({
      where: {
        key: opts.key,
      },
    });

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

const cachedFlagStore = new Map<string, { value: unknown; expiresAt: number }>();

/**
 * flag() behind a short process-level TTL cache, for global flags read on hot
 * paths (e.g. the root loader) where a database round-trip per request is too
 * expensive. Flips propagate within ttlMs per process. Overrides are rejected
 * by the type: a scoped resolution must never be reused across scopes.
 */
export async function cachedFlag<T extends FeatureFlagKey>(
  opts: Omit<FlagsOptions<T>, "overrides"> & {
    defaultValue: z.infer<(typeof FeatureFlagCatalog)[T]>;
  },
  ttlMs = 30_000
): Promise<z.infer<(typeof FeatureFlagCatalog)[T]>> {
  // defaultValue resolves the flag when the row is absent, so it's part of the key
  const cacheKey = `${opts.key}:${JSON.stringify(opts.defaultValue)}`;
  const hit = cachedFlagStore.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as z.infer<(typeof FeatureFlagCatalog)[T]>;
  }

  const value = await flag(opts);
  cachedFlagStore.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
  return value;
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

type AllFlagsOptions = {
  defaultValues?: Partial<FeatureFlagCatalog>;
  overrides?: Record<string, unknown>;
};

function makeFlags(_prisma: PrismaClientOrTransaction = prisma) {
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

// Global flag groups whose value carries its own grace stamp. `primary` is operator-supplied;
// `derived` is computed server-side and must never be written from a request body. The pair is
// named explicitly rather than by position, so a group declared in another order stays correct.
const GRACED_GLOBAL_GROUPS = [
  {
    primary: FEATURE_FLAG.runOpsMintKind as FeatureFlagKey,
    derived: [
      FEATURE_FLAG.runOpsMintKindPrev,
      FEATURE_FLAG.runOpsMintKindFlippedAt,
    ] as FeatureFlagKey[],
    stamp: stampMintKindFlip,
  },
  {
    primary: FEATURE_FLAG.runOpsMintShardSet as FeatureFlagKey,
    derived: [
      FEATURE_FLAG.runOpsMintShardSetPrev,
      FEATURE_FLAG.runOpsMintShardSetFlippedAt,
    ] as FeatureFlagKey[],
    stamp: stampMintShardSetFlip,
  },
] as const;

const GRACED_GLOBAL_KEYS: FeatureFlagKey[] = GRACED_GLOBAL_GROUPS.flatMap((g) => [
  g.primary,
  ...g.derived,
]);

function gracedGroupFor(key: FeatureFlagKey) {
  return GRACED_GLOBAL_GROUPS.find((g) => g.primary === key || g.derived.includes(key));
}

// Strips every derived key: a grace stamp is computed here, never accepted from a caller.
function withoutDerivedKeys(
  requestedFlags: Partial<z.infer<typeof FeatureFlagCatalogSchema>>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...requestedFlags };
  for (const group of GRACED_GLOBAL_GROUPS) {
    for (const derived of group.derived) {
      delete out[derived];
    }
  }
  return out;
}

// The rows may not exist yet, so a row FOR UPDATE cannot lock them; an advisory xact lock
// serializes concurrent global flips instead, so one cannot clobber another's stamp.
//
// Two lock ids are taken, in a fixed order. The second is this release's name; the first is the
// name an older release still takes. A deploy rolls for hours, so both versions write at once,
// and dropping the old id would leave those writers serializing against nothing. Remove the
// legacy id one release after this one ships.
async function lockGracedGroups(tx: PrismaClientOrTransaction): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runops-global-mint-kind-flip'))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runops-global-graced-flag-flip'))`;
}

// Reads each group's current rows and returns the requested flags plus a fresh stamp for every
// group the save actually changes. A group whose primary the save omits is left untouched.
async function stampGracedGroups(
  tx: PrismaClientOrTransaction,
  requestedFlags: Record<string, unknown>,
  graceMs: number
): Promise<Record<string, unknown>> {
  const existingRows = await tx.featureFlag.findMany({
    where: { key: { in: GRACED_GLOBAL_KEYS } },
    select: { key: true, value: true },
  });
  const existingGlobal: Record<string, unknown> = {};
  for (const row of existingRows) {
    existingGlobal[row.key] = row.value;
  }

  // Anchor the cutover to the control-plane DB clock, not this process's wall clock. A rolling
  // deploy spans hours, so every pod must date the window against one shared clock.
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

  let stamped: Record<string, unknown> = { ...requestedFlags };
  for (const group of GRACED_GLOBAL_GROUPS) {
    stamped = group.stamp(existingGlobal, stamped, now.getTime(), graceMs);
  }
  return stamped;
}

// Merge-semantics write: sets what the caller asked for, stamps any graced group it changes, and
// touches nothing else. Used by the JSON admin API.
export async function applyGlobalGracedFlips(
  client: PrismaClient,
  requestedFlags: Partial<z.infer<typeof FeatureFlagCatalogSchema>>,
  graceMs: number
): Promise<{ key: string; value: any }[]> {
  return client.$transaction(async (tx) => {
    await lockGracedGroups(tx);
    const stamped = await stampGracedGroups(tx, withoutDerivedKeys(requestedFlags), graceMs);
    return makeSetMultipleFlags(tx)(stamped as Partial<z.infer<typeof FeatureFlagCatalogSchema>>);
  });
}

// Replace-semantics write for the global admin flags page: submitted flags upsert, omitted ones
// delete unless protected. One transaction covers the stamp, the upserts and the deletes, so a
// save cannot half-apply.
//
// A graced group is all-or-nothing. Submitting its primary writes the group with a fresh stamp.
// Omitting its primary deletes the primary AND its stamp together, because a stamp left behind
// without its primary keeps being served: {set: [], prevSet: [a], flippedAt: t} resolves to [a]
// for the rest of the window, which would mint into a shard the operator just removed. The
// delete ignores `isProtected` for the derived keys for the same reason.
export async function replaceGlobalFeatureFlags(
  client: PrismaClient,
  params: {
    requestedFlags: Partial<z.infer<typeof FeatureFlagCatalogSchema>>;
    catalogKeys: FeatureFlagKey[];
    isProtected: (key: FeatureFlagKey) => boolean;
    graceMs: number;
  }
): Promise<void> {
  const requestedFlags = withoutDerivedKeys(params.requestedFlags);

  await client.$transaction(async (tx) => {
    await lockGracedGroups(tx);
    const stamped = await stampGracedGroups(tx, requestedFlags, params.graceMs);

    const toWrite: Record<string, unknown> = {};
    const keysToDelete: string[] = [];

    for (const key of params.catalogKeys) {
      const group = gracedGroupFor(key);

      if (group) {
        if (requestedFlags[group.primary] !== undefined) {
          if (stamped[key] !== undefined) {
            toWrite[key] = stamped[key];
          }
        } else if (!params.isProtected(group.primary)) {
          keysToDelete.push(key);
        }
        continue;
      }

      if (key in requestedFlags) {
        toWrite[key] = requestedFlags[key];
      } else if (!params.isProtected(key)) {
        keysToDelete.push(key);
      }
    }

    await makeSetMultipleFlags(tx)(toWrite as Partial<z.infer<typeof FeatureFlagCatalogSchema>>);

    if (keysToDelete.length > 0) {
      await tx.featureFlag.deleteMany({ where: { key: { in: boundedIn(keysToDelete) } } });
    }
  });
}

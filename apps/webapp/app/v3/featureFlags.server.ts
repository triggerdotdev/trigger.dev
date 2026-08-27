import { type z } from "zod";
import type { PrismaClient } from "@trigger.dev/database";
import {
  FEATURE_FLAG,
  type FeatureFlagCatalogSchema,
  type FeatureFlagKey,
  FeatureFlagCatalog,
  GLOBAL_LOCKED_FLAGS,
  GRACED_FLAG_GROUPS,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";
import { env } from "~/env.server";
import { stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";
import { stampMintShardSetFlip } from "~/v3/runOpsMigration/mintShardGrace";
import { $transaction, boundedIn, prisma, type PrismaClientOrTransaction } from "~/db.server";

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

// The key topology lives in the shared module, because the admin page needs it too. This adds
// the stamping behaviour, which is server-only.
const GRACED_GLOBAL_GROUPS = GRACED_FLAG_GROUPS.map((group) => ({
  ...group,
  stamp: group.primary === FEATURE_FLAG.runOpsMintKind ? stampMintKindFlip : stampMintShardSetFlip,
}));

const GRACED_GLOBAL_KEYS: FeatureFlagKey[] = GRACED_GLOBAL_GROUPS.flatMap((g) => [
  g.primary,
  ...g.derived,
]);

function gracedGroupFor(key: FeatureFlagKey) {
  return GRACED_GLOBAL_GROUPS.find((g) => g.primary === key || g.derived.includes(key));
}

// True when a save changes any graced group, and therefore needs the stamped path. Derived from
// the group table, so adding a group cannot leave a caller silently writing an unstamped flip.
export function touchesGracedGroup(requestedFlags: Record<string, unknown>): boolean {
  return GRACED_GLOBAL_GROUPS.some((group) => requestedFlags[group.primary] !== undefined);
}

// Strips every derived key: a grace stamp is computed here, never accepted from a caller.
// Only the flags whose stored value differs. Each write is a round trip inside an interactive
// transaction, so writing an unchanged flag costs a round trip for nothing.
export function flagsNeedingWrite(
  requested: Record<string, unknown>,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(requested)) {
    if (JSON.stringify(existing[key] ?? null) !== JSON.stringify(value ?? null)) {
      out[key] = value;
    }
  }
  return out;
}

export function withoutDerivedKeys(
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
// Two lock ids are taken, in a fixed order. The FIRST is the operative one: an older release
// takes only that id, and a deploy rolls for hours, so it is the id that serializes across both
// versions. The second is this release's name and adds nothing until every writer takes it.
// Renaming without keeping the old id is what would leave the two versions unserialized. Remove
// the legacy id one release after this one ships, when nothing takes it alone.
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
    where: { key: { in: boundedIn(GRACED_GLOBAL_KEYS) } },
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
  const applied = await $transaction(client, "applyGlobalGracedFlips", async (tx) => {
    await lockGracedGroups(tx);
    const stamped = await stampGracedGroups(tx, withoutDerivedKeys(requestedFlags), graceMs);
    return makeSetMultipleFlags(tx)(stamped as Partial<z.infer<typeof FeatureFlagCatalogSchema>>);
  });

  // The helper resolves undefined rather than throwing when Prisma swallows an infrastructure
  // error. This write stamps a cutover window, so a transaction that did not run must be loud.
  if (!applied) {
    throw new Error("applyGlobalGracedFlips: transaction did not complete");
  }
  return applied;
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
    requestedFlags: Record<string, unknown>;
    catalogKeys: FeatureFlagKey[];
    isManagedCloud: boolean;
    unlockLockedFlags: boolean;
    graceMs: number;
  }
): Promise<void> {
  const requestedFlags = withoutDerivedKeys(params.requestedFlags);

  // A locked flag absent from the payload means the page never offered it, not that the admin
  // unset it, so it survives. Only a self-hosted page that says it unlocked them may delete one.
  const canDeleteLocked = params.unlockLockedFlags && !params.isManagedCloud;
  const isProtected = (key: FeatureFlagKey) =>
    !canDeleteLocked && GLOBAL_LOCKED_FLAGS.includes(key);

  const applied = await $transaction(client, "replaceGlobalFeatureFlags", async (tx) => {
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
        } else if (!isProtected(group.primary)) {
          keysToDelete.push(key);
        }
        continue;
      }

      if (key in requestedFlags) {
        toWrite[key] = requestedFlags[key];
      } else if (!isProtected(key)) {
        keysToDelete.push(key);
      }
    }

    // One round trip to learn the stored values, then a write only for what actually differs.
    // makeSetMultipleFlags upserts sequentially, so an unchanged flag costs a round trip for
    // nothing, and this transaction is interactive and holds a pooled connection.
    const writeKeys = Object.keys(toWrite);
    if (writeKeys.length > 0) {
      const storedRows = await tx.featureFlag.findMany({
        where: { key: { in: boundedIn(writeKeys) } },
        select: { key: true, value: true },
      });
      const stored: Record<string, unknown> = {};
      for (const row of storedRows) {
        stored[row.key] = row.value;
      }

      await makeSetMultipleFlags(tx)(
        flagsNeedingWrite(toWrite, stored) as Partial<z.infer<typeof FeatureFlagCatalogSchema>>
      );
    }

    if (keysToDelete.length > 0) {
      await tx.featureFlag.deleteMany({ where: { key: { in: boundedIn(keysToDelete) } } });
    }

    return true;
  });

  // This write deletes flags, so a transaction that did not run must reach the caller.
  if (!applied) {
    throw new Error("replaceGlobalFeatureFlags: transaction did not complete");
  }
}

/** The global flag set, with the env-var defaults this app applies. */
export async function globalFeatureFlags() {
  return flags({
    defaultValues: {
      hasAiAccess: env.AI_FEATURES_ENABLED === "1",
      hasDashboardAgentAccess: env.DASHBOARD_AGENT_ENABLED === "1",
      hasPrivateConnections: env.PRIVATE_CONNECTIONS_ENABLED === "1",
    },
  });
}

/** The global set with one org's overrides on top. */
export function mergeOrgFeatureFlags(
  globalFlags: Partial<FeatureFlagCatalog>,
  orgFeatureFlags: unknown
) {
  const parsed = orgFeatureFlags
    ? validatePartialFeatureFlags(orgFeatureFlags as Record<string, unknown>)
    : ({ success: false } as const);
  return { ...globalFlags, ...(parsed.success ? parsed.data : {}) };
}

/**
 * The flags that apply to one organization. Server-side callers that need the
 * same set the side menu sees should use this rather than assembling their own,
 * so a partial set can't silently disagree with it.
 */
export async function resolveOrganizationFeatureFlags(orgFeatureFlags: unknown) {
  return mergeOrgFeatureFlags(await globalFeatureFlags(), orgFeatureFlags);
}

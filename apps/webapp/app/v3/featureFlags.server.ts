import { type z } from "zod";
import type { PrismaClient } from "@trigger.dev/database";
import cuid from "cuid";
import {
  boundedIn,
  Prisma,
  prisma,
  sqlDatabaseSchema,
  type PrismaClientOrTransaction,
} from "~/db.server";
import { startActiveSpan } from "~/v3/tracer.server";
import {
  FEATURE_FLAG,
  type FeatureFlagCatalogSchema,
  type FeatureFlagKey,
  FeatureFlagCatalog,
  GLOBAL_LOCKED_FLAGS,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";
import { env } from "~/env.server";
import { stampMintKindFlip } from "~/v3/runOpsMigration/mintFlipGrace";

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

// Read -> stamp -> write the global mint-kind grace metadata in one transaction. The three
// FeatureFlag rows may not exist yet, so a row FOR UPDATE can't lock them; an advisory xact lock
// serializes concurrent global flips so one can't clobber another's grace stamp (mirrors per-org).
export async function applyGlobalMintKindFlip(
  client: PrismaClient,
  requestedFlags: Partial<z.infer<typeof FeatureFlagCatalogSchema>>,
  graceMs: number
): Promise<{ key: string; value: any }[]> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('runops-global-mint-kind-flip'))`;

    const existingRows = await tx.featureFlag.findMany({
      where: {
        key: {
          in: [
            FEATURE_FLAG.runOpsMintKind,
            FEATURE_FLAG.runOpsMintKindPrev,
            FEATURE_FLAG.runOpsMintKindFlippedAt,
          ],
        },
      },
      select: { key: true, value: true },
    });
    const existingGlobal: Record<string, unknown> = {};
    for (const row of existingRows) {
      existingGlobal[row.key] = row.value;
    }

    // Anchor the cutover to the control-plane DB clock, not this process's wall clock.
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;

    const stamped = stampMintKindFlip(
      existingGlobal,
      { ...requestedFlags },
      now.getTime(),
      graceMs
    ) as Partial<z.infer<typeof FeatureFlagCatalogSchema>>;

    return makeSetMultipleFlags(tx)(stamped);
  });
}

/**
 * Replace-semantics write for the global admin flags page: catalog keys present in
 * `requestedFlags` are upserted, catalog keys absent from it are deleted.
 *
 * A locked flag absent from the payload means the page never offered it for editing, not that
 * the admin unset it, so it survives the sweep. Only a self-hosted page that says it unlocked
 * them can delete one.
 */
export async function replaceGlobalFeatureFlags(
  client: PrismaClient,
  params: {
    requestedFlags: Record<string, unknown>;
    catalogKeys: FeatureFlagKey[];
    isManagedCloud: boolean;
    unlockLockedFlags: boolean;
  }
): Promise<void> {
  const canDeleteLocked = params.unlockLockedFlags && !params.isManagedCloud;
  const toUpsert: { key: FeatureFlagKey; value: unknown }[] = [];
  const keysToDelete: string[] = [];

  for (const key of params.catalogKeys) {
    if (key in params.requestedFlags) {
      toUpsert.push({ key, value: params.requestedFlags[key] });
    } else if (canDeleteLocked || !GLOBAL_LOCKED_FLAGS.includes(key)) {
      keysToDelete.push(key);
    }
  }

  // The upsert and the sweep touch disjoint keys, because the loop above sends each catalog key
  // to exactly one of the two lists. That lets them combine into a single data-modifying
  // statement, which is atomic on its own and costs one round trip whatever the catalog size.
  const upsertSql =
    toUpsert.length > 0
      ? Prisma.sql`
          INSERT INTO ${sqlDatabaseSchema}."FeatureFlag" (id, key, value, "createdAt", "updatedAt")
          VALUES ${Prisma.join(
            toUpsert.map(
              ({ key, value }) =>
                Prisma.sql`(${cuid()}, ${key}, ${JSON.stringify(
                  value ?? null
                )}::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
            )
          )}
          ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, "updatedAt" = CURRENT_TIMESTAMP`
      : undefined;

  const deleteSql =
    keysToDelete.length > 0
      ? Prisma.sql`
          DELETE FROM ${sqlDatabaseSchema}."FeatureFlag"
          WHERE key IN (${Prisma.join(boundedIn(keysToDelete))})`
      : undefined;

  const statement =
    upsertSql && deleteSql
      ? Prisma.sql`WITH upserted AS (${upsertSql} RETURNING 1) ${deleteSql}`
      : (upsertSql ?? deleteSql);

  if (!statement) {
    return;
  }

  await startActiveSpan("replaceGlobalFeatureFlags", () => client.$executeRaw(statement));
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

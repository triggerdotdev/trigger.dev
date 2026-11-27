import { z } from "zod";
import type { env } from "~/env.server";
import {
  FEATURE_FLAG,
  FeatureFlagCatalog,
  type FeatureFlagKey,
  isPlainFlagObject,
} from "~/v3/featureFlags";
import { logger } from "~/services/logger.server";
import { hasBooleanBeenOn, readGracedBoolean } from "~/v3/runOpsMigration/mintFlipGrace";

type ReadGlobalFlags = () => Partial<FeatureFlagCatalog> | undefined;

// Other projects' flags, read by name until each project adds its own to the catalogue.
const OTHER_PROJECT_FLAGS = {
  activeRunStoreEnabled: "activeRunStoreEnabled",
  checkpointStoreEnabled: "checkpointStoreEnabled",
  clickhouseFeedEnabled: "clickhouseFeedEnabled",
  realtimeNativeOnly: "realtimeNativeOnly",
} as const;

function readOverride(organizationFlags: unknown, key: string): unknown {
  return isPlainFlagObject(organizationFlags) && Object.hasOwn(organizationFlags, key)
    ? organizationFlags[key]
    : undefined;
}

/**
 * Organisation override, then the global value, then off. A key outside the catalogue is parsed as
 * a strict boolean; once its project adds it, its catalogue schema and global value apply.
 */
function readFlagByName(
  key: string,
  organizationFlags: unknown,
  readGlobalFlags: ReadGlobalFlags
): boolean {
  const override = readOverride(organizationFlags, key);
  if (override !== undefined) {
    const schema: z.ZodTypeAny = Object.hasOwn(FeatureFlagCatalog, key)
      ? FeatureFlagCatalog[key as FeatureFlagKey]
      : z.boolean();
    const parsed = schema.safeParse(override);
    if (parsed.success) return parsed.data === true;
  }
  const global = (readGlobalFlags() as Record<string, unknown> | undefined)?.[key];
  return typeof global === "boolean" ? global : false;
}

/** Read through its grace stamp. No flags in hand reads as off, with no read of the global flags. */
export function createRunResidencyEnabledResolver(
  readGlobalFlags: ReadGlobalFlags,
  graceMs: number
) {
  return (organizationFlags?: unknown): boolean =>
    organizationFlags !== undefined &&
    readGracedBoolean(
      FEATURE_FLAG.runResidencyEnabled,
      organizationFlags,
      readGlobalFlags() as Record<string, unknown> | undefined,
      Date.now(),
      graceMs
    );
}

/** Whether the switch is, or has been, on for the organisation. No flags in hand reads as no. */
export function createRunResidencyHasBeenOnResolver(readGlobalFlags: ReadGlobalFlags) {
  return (organizationFlags?: unknown): boolean =>
    organizationFlags !== undefined &&
    hasBooleanBeenOn(
      FEATURE_FLAG.runResidencyEnabled,
      organizationFlags,
      readGlobalFlags() as Record<string, unknown> | undefined
    );
}

type RunResidencyAllowedDeps = {
  env: Pick<
    typeof env,
    | "RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL"
    | "RUN_ENGINE_WAITPOINT_STORE_REDIS_URL"
    | "REALTIME_BACKEND_NATIVE_ENABLED"
    | "REALTIME_BACKEND_DEFAULT"
    | "TRIGGER_MOLLIFIER_ENABLED"
  >;
  isSplitEnabled: () => Promise<boolean>;
  readGlobalFlags: ReadGlobalFlags;
  graceMs: number;
};

/** The switch and the enrolment rule, from memory only, in order; a throw reads as not allowed. */
export function createRunResidencyAllowedResolver(deps: RunResidencyAllowedDeps) {
  return async (organizationFlags?: unknown): Promise<boolean> => {
    if (organizationFlags === undefined) return false;
    try {
      const globalFlags = deps.readGlobalFlags();
      const read = (key: string) => readFlagByName(key, organizationFlags, () => globalFlags);

      return (
        createRunResidencyEnabledResolver(() => globalFlags, deps.graceMs)(organizationFlags) &&
        (await deps.isSplitEnabled()) &&
        !!deps.env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL &&
        !!deps.env.RUN_ENGINE_WAITPOINT_STORE_REDIS_URL &&
        read(FEATURE_FLAG.waitpointStoreEnabled) &&
        read(OTHER_PROJECT_FLAGS.activeRunStoreEnabled) &&
        read(OTHER_PROJECT_FLAGS.checkpointStoreEnabled) &&
        read(OTHER_PROJECT_FLAGS.clickhouseFeedEnabled) &&
        (read(OTHER_PROJECT_FLAGS.realtimeNativeOnly) ||
          (deps.env.REALTIME_BACKEND_NATIVE_ENABLED === "1" &&
            realtimeBackend(organizationFlags, globalFlags, deps.env) === "native")) &&
        // Only the process switch and the organisation override, as the mollifier gate reads them.
        !(
          deps.env.TRIGGER_MOLLIFIER_ENABLED === "1" &&
          FeatureFlagCatalog[FEATURE_FLAG.mollifierEnabled].safeParse(
            readOverride(organizationFlags, FEATURE_FLAG.mollifierEnabled)
          ).data === true
        )
      );
    } catch (error) {
      logger.warn("runResidency.rule_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
}

/** The backend in the realtime flag's order, from the global flags in memory, not the database. */
function realtimeBackend(
  organizationFlags: unknown,
  globalFlags: Partial<FeatureFlagCatalog> | undefined,
  processEnv: RunResidencyAllowedDeps["env"]
) {
  const override = FeatureFlagCatalog[FEATURE_FLAG.realtimeBackend].safeParse(
    readOverride(organizationFlags, FEATURE_FLAG.realtimeBackend)
  );
  return override.success
    ? override.data
    : (globalFlags?.realtimeBackend ?? processEnv.REALTIME_BACKEND_DEFAULT);
}

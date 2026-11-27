import {
  organizationContext,
  type MemoryDbGate,
  type OrganizationContext,
} from "@internal/run-store";
import type { FeatureFlagCatalog } from "~/v3/featureFlags";
import { logger } from "~/services/logger.server";
import {
  createRunResidencyHasBeenOnResolver,
  OTHER_PROJECT_FLAGS,
  readFlagByName,
} from "./runResidency.server";

type ResolvedEnvironment = { organization: { featureFlags: unknown } } | null;

type RunResidencyGateDeps = {
  readGlobalFlags: () => Partial<FeatureFlagCatalog> | undefined;
  resolveAuthenticatedEnv: (environmentId: string) => Promise<ResolvedEnvironment>;
};

/** Decides from the caller's organisation context; no I/O until a member is asked. */
export function createRunResidencyGate(deps: RunResidencyGateDeps): MemoryDbGate {
  // One look-up per scope, kept with the context object, not across scopes.
  const lookups = new WeakMap<OrganizationContext, Promise<ResolvedEnvironment>>();

  // `undefined` when the context names no environment; otherwise the flags, `null` included.
  async function flagsOf(context: OrganizationContext | undefined): Promise<unknown> {
    if (!context?.environmentId) return undefined;
    if (context.featureFlags !== undefined) return context.featureFlags;
    let lookup = lookups.get(context);
    if (!lookup) {
      lookup = deps.resolveAuthenticatedEnv(context.environmentId);
      lookups.set(context, lookup);
    }
    const environment = await lookup;
    return environment === null ? undefined : environment.organization.featureFlags;
  }

  return {
    bornHere: () => organizationContext.get()?.bornHere === true,
    async organizationOpens() {
      const flags = await flagsOf(organizationContext.get());
      if (flags === undefined) return false;
      try {
        const globalFlags = deps.readGlobalFlags();
        return (
          readFlagByName(OTHER_PROJECT_FLAGS.activeRunStoreEnabled, flags, () => globalFlags) &&
          createRunResidencyHasBeenOnResolver(() => globalFlags)(flags)
        );
      } catch (error) {
        logger.warn("runResidency.gate_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    async archiveFlagsOn() {
      const flags = await flagsOf(organizationContext.get());
      if (flags === undefined) return false;
      try {
        const globalFlags = deps.readGlobalFlags();
        return (
          readFlagByName(OTHER_PROJECT_FLAGS.archiveStoreEnabled, flags, () => globalFlags) &&
          readFlagByName(OTHER_PROJECT_FLAGS.archiveReadPathEnabled, flags, () => globalFlags)
        );
      } catch (error) {
        logger.warn("runResidency.gate_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
}

import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import type { FeatureFlagCatalog } from "~/v3/featureFlags";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { memoryDbStoreRegistered } from "~/v3/runStore.server";
import { createRunResidencyAllowedResolver, readFlagByName } from "~/v3/utils/runResidency.server";
import { isSplitEnabled } from "./splitMode.server";

/** The behaviour groups a root's kind can depend on, as the MemoryDB run store names them. */
type RootResidencyGroup =
  | "parentAndChild"
  | "batchMembership"
  | "idempotencyKeyFields"
  | "delayAndRescheduling"
  | "debounce";

const ALL_GROUPS: readonly RootResidencyGroup[] = [
  "parentAndChild",
  "batchMembership",
  "idempotencyKeyFields",
  "delayAndRescheduling",
  "debounce",
];

type RootResidencyDeps = {
  isResidencyAllowed: (organizationFlags?: unknown) => Promise<boolean>;
  readGlobalFlags: () => Partial<FeatureFlagCatalog> | undefined;
  /** The groups the MemoryDB run store does not support yet; `undefined` is nothing published. */
  readUnsupportedGroups: () => readonly RootResidencyGroup[] | undefined;
  memoryDbStoreRegistered: () => boolean;
};

type RootRunKind = { keyed: boolean; token: boolean; delayed: boolean; debounced: boolean };

type RootBatchKind =
  | { endpoint: "streaming" }
  | { endpoint: "v2"; token: boolean; itemKeyed: () => boolean };

/** Whether a new root is born under the MemoryDB key; from memory only, a throw reads as no. */
export function createRootResidencyDecision(deps: RootResidencyDeps) {
  const idempotencyStoreEnabled = (organizationFlags: unknown): boolean =>
    readFlagByName("idempotencyStoreEnabled", organizationFlags, deps.readGlobalFlags);
  const batchStoreEnabled = (organizationFlags: unknown): boolean =>
    readFlagByName("batchStoreEnabled", organizationFlags, deps.readGlobalFlags);

  const supports = (...groups: RootResidencyGroup[]) => {
    const unsupported = deps.readUnsupportedGroups();
    return unsupported !== undefined && groups.every((group) => !unsupported.includes(group));
  };

  async function decide(organizationFlags: unknown, admits: () => boolean): Promise<boolean> {
    if (organizationFlags === undefined) return false;
    try {
      return (
        deps.memoryDbStoreRegistered() &&
        (await deps.isResidencyAllowed(organizationFlags)) &&
        admits()
      );
    } catch (error) {
      logger.warn("runResidency.root_decision_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return {
    idempotencyStoreEnabled,
    batchStoreEnabled,
    allowsRootRun: (organizationFlags: unknown, kind: RootRunKind) =>
      decide(
        organizationFlags,
        () =>
          (!(kind.keyed || kind.token) ||
            (idempotencyStoreEnabled(organizationFlags) && supports("idempotencyKeyFields"))) &&
          (!kind.delayed || supports("delayAndRescheduling")) &&
          // A debounced run is always delayed (debounce.delay sets delayUntil).
          (!kind.debounced || supports("debounce", "delayAndRescheduling"))
      ),
    allowsRootBatch: (organizationFlags: unknown, batch: RootBatchKind) =>
      decide(
        organizationFlags,
        () =>
          batchStoreEnabled(organizationFlags) &&
          supports(...ALL_GROUPS) &&
          (idempotencyStoreEnabled(organizationFlags) ||
            (batch.endpoint === "v2" && !batch.token && !batch.itemKeyed()))
      ),
  };
}

export const rootResidency = createRootResidencyDecision({
  isResidencyAllowed: (organizationFlags) =>
    createRunResidencyAllowedResolver({
      env,
      isSplitEnabled: () => isSplitEnabled(),
      readGlobalFlags: () => globalFlagsRegistry.current(),
      graceMs: env.RUN_OPS_MINT_FLIP_GRACE_MS,
    })(organizationFlags),
  readGlobalFlags: () => globalFlagsRegistry.current(),
  // Nothing is published yet, so only simple roots are admitted.
  readUnsupportedGroups: () => undefined,
  memoryDbStoreRegistered: () => memoryDbStoreRegistered(),
});

export const idempotencyStoreEnabled = rootResidency.idempotencyStoreEnabled;
export const batchStoreEnabled = rootResidency.batchStoreEnabled;

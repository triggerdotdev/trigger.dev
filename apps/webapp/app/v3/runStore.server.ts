import { PostgresRunStore, RoutingRunStore, type RunStore } from "@internal/run-store";
import { ownerEngine, type Residency } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient, PrismaReplicaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  $replica,
  prisma,
  runOpsLegacyPrisma,
  runOpsLegacyReplica,
  runOpsNewPrismaClient,
  runOpsNewReplicaClient,
} from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

type BuildRunStoreDeps = {
  /** Boot constant: true only when both run-ops DBs are configured and the split flag is on. */
  splitEnabled: boolean;
  /** Split-only handles. Required when splitEnabled is true; omitted entirely when OFF
   * so single-DB callers never touch the run-ops clients (keeps mocks/passthrough clean). */
  newWriter?: RunOpsPrismaClient;
  newReplica?: RunOpsPrismaClient;
  legacyWriter?: PrismaClient;
  legacyReplica?: PrismaReplicaClient;
  /** Single-DB store handles (control-plane pair). Used verbatim when split is OFF. */
  singleWriter: PrismaClient;
  singleReplica: PrismaReplicaClient;
  /** Residency classifier; defaults to ownerEngine inside RoutingRunStore. */
  classify?: (id: string) => Residency;
};

/**
 * Pure run-store builder (no env / no boot side effects — webapp testability rule).
 *
 * Split OFF (default / self-host): returns the exact passthrough PostgresRunStore we
 * have always returned, built from the single control-plane handles. No second store
 * is constructed and no marker predicate is consulted, so behavior is byte-identical
 * to single-DB today.
 *
 * Split ON: returns a RoutingRunStore that selects between a NEW store (where new runs
 * are born) and a LEGACY store (draining) by run-id residency (id shape). There is no cuid
 * migration, so a LEGACY-classified id is always LEGACY-resident.
 */
export function buildRunStore(deps: BuildRunStoreDeps): RunStore {
  if (!deps.splitEnabled) {
    return new PostgresRunStore({
      prisma: deps.singleWriter,
      readOnlyPrisma: deps.singleReplica,
    });
  }

  if (!deps.newWriter || !deps.newReplica || !deps.legacyWriter || !deps.legacyReplica) {
    throw new Error("buildRunStore: split is enabled but run-ops store handles are missing");
  }
  // The NEW store is backed by the dedicated RunOpsPrismaClient (subset schema): relation-shaped
  // ops branch onto FK-free scalars + explicit join models. The LEGACY store keeps the default
  // "legacy" variant (full @trigger.dev/database schema with implicit M2M + @relations).
  const newStore = new PostgresRunStore({
    prisma: deps.newWriter,
    readOnlyPrisma: deps.newReplica,
    schemaVariant: "dedicated",
  });
  const legacyStore = new PostgresRunStore({
    prisma: deps.legacyWriter,
    readOnlyPrisma: deps.legacyReplica,
  });

  return new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    classify: deps.classify ?? ownerEngine,
  });
}

// Build the routing store whenever BOTH run-ops DBs are configured, independent of
// RUN_OPS_SPLIT_ENABLED. Reads must fan out across both DBs so a run that lives on the new
// DB stays visible even with the flag off (matches the db.server topology factory). The flag
// governs write/mint residency + migration via isSplitEnabled(), not read visibility.
const ROUTING_ENABLED = !!env.RUN_OPS_DATABASE_URL && !!env.RUN_OPS_LEGACY_DATABASE_URL;

// Resolve the run-ops handles, tolerating contexts where they are absent — tests that mock
// ~/db.server minimally omit them, and accessing a missing export under vi.mock throws. A
// miss means "no run-ops handles here" and we fall back to single-store.
function tryResolveRunOpsHandles() {
  try {
    if (
      !runOpsNewPrismaClient ||
      !runOpsNewReplicaClient ||
      !runOpsLegacyPrisma ||
      !runOpsLegacyReplica
    ) {
      return null;
    }
    return {
      newWriter: runOpsNewPrismaClient,
      newReplica: runOpsNewReplicaClient,
      legacyWriter: runOpsLegacyPrisma,
      legacyReplica: runOpsLegacyReplica,
    };
  } catch {
    return null;
  }
}

export const runStore: RunStore = singleton("RunStore", () => {
  const handles = ROUTING_ENABLED ? tryResolveRunOpsHandles() : null;
  // Single-store passthrough: self-host (one DB), or a context without run-ops handles.
  if (!handles) {
    return buildRunStore({
      splitEnabled: false,
      singleWriter: prisma,
      singleReplica: $replica,
    });
  }
  return buildRunStore({
    splitEnabled: true,
    ...handles,
    singleWriter: prisma,
    singleReplica: $replica,
  });
});

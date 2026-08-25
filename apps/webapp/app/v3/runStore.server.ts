import {
  PostgresRunStore,
  RoutingRunStore,
  type RoutingStoreMetrics,
  type RunStore,
} from "@internal/run-store";
import { resolveShard, type ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { Counter } from "prom-client";
import { metricsRegister } from "~/metrics.server";
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
import {
  resilienceForClient,
  type TransactionResilienceConfig,
} from "./transactionResilience.server";

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
  /** Id-to-shard-key resolver; defaults to the core resolveShard inside RoutingRunStore. */
  resolveShard?: (id: string) => ShardKey;
  /** Per-pool transaction-resilience configs threaded into the store(s) this builds (IoC). */
  singleResilience?: TransactionResilienceConfig;
  newResilience?: TransactionResilienceConfig;
  legacyResilience?: TransactionResilienceConfig;
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
      maxWait: deps.singleResilience?.maxWait,
      transactionStartRetry: deps.singleResilience?.startRetry,
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
    maxWait: deps.newResilience?.maxWait,
    transactionStartRetry: deps.newResilience?.startRetry,
  });
  const legacyStore = new PostgresRunStore({
    prisma: deps.legacyWriter,
    readOnlyPrisma: deps.legacyReplica,
    maxWait: deps.legacyResilience?.maxWait,
    transactionStartRetry: deps.legacyResilience?.startRetry,
  });

  return new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    resolveShard: deps.resolveShard ?? resolveShard,
    metrics: routingStoreMetrics,
  });
}

// singleton: module-scope Counter registration double-registers under dev HMR.
const routingStoreMetrics: RoutingStoreMetrics = singleton("routingStoreMetrics", () => {
  const duplicateId = new Counter({
    name: "runops_shard_duplicate_id_total",
    help: "One id was returned by two run-ops shards that must be disjoint (a routing-invariant violation).",
    labelNames: ["shard_keys"],
    registers: [metricsRegister],
  });
  const probeFallback = new Counter({
    name: "runops_waitpoint_probe_fallback_total",
    help: "A waitpoint was not on the run-ops store its id named and was found by a fallback probe.",
    labelNames: ["from", "to"],
    registers: [metricsRegister],
  });
  return {
    recordDuplicateId: (shardKeys) => duplicateId.inc({ shard_keys: shardKeys.join(",") }),
    recordWaitpointProbeFallback: (from, to) => probeFallback.inc({ from, to }),
  };
});

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
      singleResilience: resilienceForClient(prisma),
    });
  }
  return buildRunStore({
    splitEnabled: true,
    ...handles,
    singleWriter: prisma,
    singleReplica: $replica,
    singleResilience: resilienceForClient(prisma),
    newResilience: resilienceForClient(handles.newWriter),
    legacyResilience: resilienceForClient(handles.legacyWriter),
  });
});

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
  runOpsShardHandles,
} from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { isSnapshotStoreConfigured } from "./snapshotStoreConfigured.server";
import { decorateWithSnapshotStore } from "./snapshotStoreInstance.server";
import { snapshotStoreModeResolver } from "./snapshotStoreMode.server";
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
  /** Gen-2 shard handles. When non-empty, buildRunStore builds one dedicated store per descriptor and
   * hands them to the N-way router; an aliased shard shares its target's database. Empty/absent keeps
   * the two-store compat router. */
  shards?: Array<{
    key: ShardKey;
    writer: RunOpsPrismaClient;
    replica: RunOpsPrismaClient;
    aliasOf?: ShardKey;
    resilience?: TransactionResilienceConfig;
  }>;
  /** Per-pool transaction-resilience configs threaded into the store(s) this builds (IoC). */
  singleResilience?: TransactionResilienceConfig;
  newResilience?: TransactionResilienceConfig;
  legacyResilience?: TransactionResilienceConfig;
  /** The redis-only PG-suppression predicate, or undefined for a plain passthrough. Passed in (never
   * read from env here) so this builder stays pure; the caller wires it only when the store is
   * configured, so an unconfigured deploy writes every snapshot row with no per-write resolution. */
  snapshotWrites?: (organizationId?: string) => boolean;
};

/**
 * Pure run-store builder (no env / no boot side effects — webapp testability rule).
 *
 * Split OFF (default / self-host): returns the exact passthrough PostgresRunStore we
 * have always returned, built from the single control-plane handles. No second store
 * is constructed, and the redis-only marker predicate is consulted only when the caller
 * wired one (i.e. the snapshot store is configured); with it unset behavior is
 * byte-identical to single-DB today.
 *
 * Split ON: returns a RoutingRunStore that selects between a NEW store (where new runs
 * are born) and a LEGACY store (draining) by run-id residency (id shape). There is no cuid
 * migration, so a LEGACY-classified id is always LEGACY-resident.
 */
// A run's org is redis-only exactly when the same resolver the snapshot decorator uses says so, so
// the Redis mirror and the Postgres suppression always agree on the effective mode for that run.
const suppressPgAtRedisOnly = (organizationId?: string) =>
  snapshotStoreModeResolver.resolve(organizationId) !== "redis-only";

// Wired into the store only when the snapshot store is configured. Unconfigured, this stays undefined
// and PostgresRunStore writes every snapshot row with no per-write mode resolution (the inert state).
const snapshotWritesPredicate = isSnapshotStoreConfigured() ? suppressPgAtRedisOnly : undefined;

export function buildRunStore(deps: BuildRunStoreDeps): RunStore {
  if (!deps.splitEnabled) {
    return new PostgresRunStore({
      prisma: deps.singleWriter,
      readOnlyPrisma: deps.singleReplica,
      maxWait: deps.singleResilience?.maxWait,
      transactionStartRetry: deps.singleResilience?.startRetry,
      snapshotWrites: deps.snapshotWrites,
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
    snapshotWrites: deps.snapshotWrites,
  });
  const legacyStore = new PostgresRunStore({
    prisma: deps.legacyWriter,
    readOnlyPrisma: deps.legacyReplica,
    maxWait: deps.legacyResilience?.maxWait,
    transactionStartRetry: deps.legacyResilience?.startRetry,
    snapshotWrites: deps.snapshotWrites,
  });

  // Gen-2 shards: one dedicated store per descriptor, handed to the N-way router. An aliased shard
  // builds a store over its target's (shared) client and carries aliasOf, so the router dedups it out
  // of fan-out sums by declaration. No shards -> the two-store compat router (byte-identical).
  const shardStores = (deps.shards ?? []).map((shard) => ({
    key: shard.key,
    store: new PostgresRunStore({
      prisma: shard.writer,
      readOnlyPrisma: shard.replica,
      schemaVariant: "dedicated" as const,
      maxWait: shard.resilience?.maxWait,
      transactionStartRetry: shard.resilience?.startRetry,
      snapshotWrites: deps.snapshotWrites,
    }),
    aliasOf: shard.aliasOf,
  }));

  return new RoutingRunStore({
    new: newStore,
    legacy: legacyStore,
    shards: shardStores.length > 0 ? shardStores : undefined,
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
  // The only per-shard series /metrics carries, so a cohort ramp is visible per shard while it
  // happens. On every routed operation: the label child is resolved once per shard and cached,
  // because `inc({ shard })` hashes a fresh label object on each call. Cardinality is bounded by
  // the shard alphabet plus the two reserved keys.
  const shardRouted = new Counter({
    name: "runops_shard_routed_total",
    help: "Operations routed to a shard by an id that resolves to it alone. Fan-outs, probes and fallback legs resolve no single shard and are excluded.",
    labelNames: ["shard"],
    registers: [metricsRegister],
  });
  const shardRoutedChildren = new Map<string, { inc: (value?: number) => void }>();
  return {
    recordDuplicateId: (shardKeys) => duplicateId.inc({ shard_keys: shardKeys.join(",") }),
    recordWaitpointProbeFallback: (from, to) => probeFallback.inc({ from, to }),
    recordShardRouted: (shardKey) => {
      let child = shardRoutedChildren.get(shardKey);
      if (child === undefined) {
        child = shardRouted.labels(shardKey);
        shardRoutedChildren.set(shardKey, child);
      }
      child.inc();
    },
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
      // Absent under a minimal db.server mock; default to no shards so the compat router is built.
      shardHandles: runOpsShardHandles ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * The router with no snapshot decorator. One intended consumer: the orphan sweeper's rule-2
 * lookup, which must ask Postgres whether a run row exists and must never be able to ask Redis
 * whether Redis is an orphan. Every other caller wants `runStore`.
 */
export const runStoreWithoutSnapshotDecorator: RunStore = singleton("RunStore.undecorated", () => {
  const handles = ROUTING_ENABLED ? tryResolveRunOpsHandles() : null;
  // Single-store passthrough: self-host (one DB), or a context without run-ops handles.
  if (!handles) {
    return buildRunStore({
      splitEnabled: false,
      singleWriter: prisma,
      singleReplica: $replica,
      singleResilience: resilienceForClient(prisma),
      snapshotWrites: snapshotWritesPredicate,
    });
  }
  const { shardHandles, ...storeHandles } = handles;
  return buildRunStore({
    splitEnabled: true,
    ...storeHandles,
    shards: shardHandles.map((shard) => ({
      key: shard.key,
      writer: shard.writer,
      replica: shard.replica,
      aliasOf: shard.aliasOf,
      resilience: resilienceForClient(shard.writer),
    })),
    singleWriter: prisma,
    singleReplica: $replica,
    singleResilience: resilienceForClient(prisma),
    newResilience: resilienceForClient(handles.newWriter),
    legacyResilience: resilienceForClient(handles.legacyWriter),
    snapshotWrites: snapshotWritesPredicate,
  });
});

export const runStore: RunStore = singleton("RunStore", () =>
  decorateWithSnapshotStore(runStoreWithoutSnapshotDecorator)
);

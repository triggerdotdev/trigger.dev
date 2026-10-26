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
import {
  resilienceForClient,
  type TransactionResilienceConfig,
} from "./transactionResilience.server";
import { globalFlagsRegistry } from "./globalFlagsRegistry.server";
import { createSnapshotRolloutResolver } from "./utils/snapshotStoreRollout.server";
import { createSnapshotConnection } from "./utils/snapshotStoreConnection.server";
import { createSnapshotStoreRuntime } from "./utils/snapshotStoreRuntime.server";
import { createSnapshotStoreMetrics } from "./utils/snapshotStoreMetrics.server";
import { logger } from "~/services/logger.server";

type BuildRunStoreDeps = {
  /** Wraps each leaf store, for example in the snapshot-store decorator. */
  decorateLeaf?: (leaf: RunStore, logicalRoute: string) => RunStore;
  /** True when both run-ops DBs are configured. RUN_OPS_SPLIT_ENABLED does not affect it. */
  splitEnabled: boolean;
  /** Required when splitEnabled is true. */
  newWriter?: RunOpsPrismaClient;
  newReplica?: RunOpsPrismaClient;
  legacyWriter?: PrismaClient;
  legacyReplica?: PrismaReplicaClient;
  singleWriter: PrismaClient;
  singleReplica: PrismaReplicaClient;
  resolveShard?: (id: string) => ShardKey;
  /** Gen-2 shards. When empty, the two-store compat router is built. */
  shards?: Array<{
    key: ShardKey;
    writer: RunOpsPrismaClient;
    replica: RunOpsPrismaClient;
    aliasOf?: ShardKey;
    resilience?: TransactionResilienceConfig;
  }>;
  singleResilience?: TransactionResilienceConfig;
  newResilience?: TransactionResilienceConfig;
  legacyResilience?: TransactionResilienceConfig;
};

/**
 * Pure: no env reads and no boot side effects, so tests can call it.
 *
 * Split off: one PostgresRunStore over the control-plane handles.
 * Split on: a RoutingRunStore that picks the NEW or LEGACY store by run-id shape. Runs never move
 * between them, so a LEGACY-shaped id always lives in LEGACY.
 */
export function buildRunStore(deps: BuildRunStoreDeps): RunStore {
  const decorate = (leaf: RunStore, route: string) => deps.decorateLeaf?.(leaf, route) ?? leaf;
  if (!deps.splitEnabled) {
    return decorate(
      new PostgresRunStore({
        prisma: deps.singleWriter,
        readOnlyPrisma: deps.singleReplica,
        maxWait: deps.singleResilience?.maxWait,
        transactionStartRetry: deps.singleResilience?.startRetry,
      }),
      "single"
    );
  }

  if (!deps.newWriter || !deps.newReplica || !deps.legacyWriter || !deps.legacyReplica) {
    throw new Error("buildRunStore: split is enabled but run-ops store handles are missing");
  }
  // NEW uses the dedicated subset schema (FK-free scalars, explicit join models). LEGACY uses the
  // full schema.
  const newStore = decorate(
    new PostgresRunStore({
      prisma: deps.newWriter,
      readOnlyPrisma: deps.newReplica,
      schemaVariant: "dedicated",
      maxWait: deps.newResilience?.maxWait,
      transactionStartRetry: deps.newResilience?.startRetry,
    }),
    "new"
  );
  const legacyStore = decorate(
    new PostgresRunStore({
      prisma: deps.legacyWriter,
      readOnlyPrisma: deps.legacyReplica,
      maxWait: deps.legacyResilience?.maxWait,
      transactionStartRetry: deps.legacyResilience?.startRetry,
    }),
    "legacy"
  );

  // An aliased shard shares its target's client. The router uses aliasOf to count it once.
  const shardStores = (deps.shards ?? []).map((shard) => ({
    key: shard.key,
    store: decorate(
      new PostgresRunStore({
        prisma: shard.writer,
        readOnlyPrisma: shard.replica,
        schemaVariant: "dedicated" as const,
        maxWait: shard.resilience?.maxWait,
        transactionStartRetry: shard.resilience?.startRetry,
      }),
      `shard:${shard.key}`
    ),
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
  // Label children are cached because `inc({ shard })` hashes a new label object on each call, and
  // this runs on every routed operation.
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

// Independent of RUN_OPS_SPLIT_ENABLED: reads must fan out across both DBs, so a run on the new DB
// stays visible with the flag off. The flag (isSplitEnabled) controls writes and migration.
const ROUTING_ENABLED = !!env.RUN_OPS_DATABASE_URL && !!env.RUN_OPS_LEGACY_DATABASE_URL;

// Returns null when the handles are absent, for example under a minimal ~/db.server mock, where a
// missing export throws. The caller then builds a single store.
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
      shardHandles: runOpsShardHandles ?? [],
    };
  } catch {
    return null;
  }
}

export const snapshotStoreRuntime = singleton("SnapshotStoreRuntime", () => {
  const endpoint = env.RUN_ENGINE_SNAPSHOT_STORE_REDIS_URL;
  if (!endpoint) return undefined;
  const metrics = createSnapshotStoreMetrics(metricsRegister);
  const connection = createSnapshotConnection(endpoint, {
    metrics: metrics.store,
    completedTtlMs: env.RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS,
    onError: (error) => logger.error("Snapshot connection error", { error }),
  });
  return createSnapshotStoreRuntime({
    connection,
    rollout: createSnapshotRolloutResolver(() => globalFlagsRegistry.current(), prisma, {
      dialCacheMs: env.RUN_ENGINE_SNAPSHOT_STORE_DIAL_CACHE_MS,
    }),
    getRunStore: () => runStore,
    metrics: metrics.decorator,
  });
});

export const runStore: RunStore = singleton("RunStore", () => {
  const handles = ROUTING_ENABLED ? tryResolveRunOpsHandles() : null;
  if (!handles) {
    return buildRunStore({
      decorateLeaf: snapshotStoreRuntime?.decorate,
      splitEnabled: false,
      singleWriter: prisma,
      singleReplica: $replica,
      singleResilience: resilienceForClient(prisma),
    });
  }
  const { shardHandles, ...storeHandles } = handles;
  return buildRunStore({
    decorateLeaf: snapshotStoreRuntime?.decorate,
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
  });
});

/**
 * Gen-2 shard client handles, keyed by shard char, for the consumers that route by
 * `resolveShard` outside the run-store boundary: read-through and the two cross-seam
 * batch hydration sites. Both maps are empty unless RUN_OPS_SHARDS is configured, which
 * is what keeps every gen-2 arm unreachable today.
 */
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaReplicaClient } from "~/db.server";
import { runOpsShardHandles } from "~/db.server";

type ShardHandle = {
  key: string;
  writer: RunOpsPrismaClient;
  replica: RunOpsPrismaClient;
  /** The DECLARED alias, if any. See nonAliasedShardReplicas. */
  aliasOf?: string;
};

export function buildShardHandleMaps(handles: ShardHandle[]): {
  replicas: ReadonlyMap<ShardKey, PrismaReplicaClient>;
  writers: ReadonlyMap<ShardKey, PrismaClient>;
} {
  const replicas = new Map<ShardKey, PrismaReplicaClient>();
  const writers = new Map<ShardKey, PrismaClient>();
  for (const handle of handles) {
    replicas.set(handle.key, handle.replica as unknown as PrismaReplicaClient);
    writers.set(handle.key, handle.writer as unknown as PrismaClient);
  }
  return { replicas, writers };
}

// A gen-2 shard is the same dedicated subset schema as the gen-1 new store, so these casts
// carry exactly the precedent (and the same residual risk) as `runOpsNewPrisma`'s.
// The try/catch mirrors `runStore.server.ts`'s handle resolution: a minimal `db.server` mock
// does not define this export at all, and accessing an undefined mock export throws.
function resolveShardHandles(): ShardHandle[] {
  try {
    return runOpsShardHandles ?? [];
  } catch {
    return [];
  }
}

/**
 * The shards a FAN-OUT should visit: one entry per physical database, in configured order.
 *
 * A shard that declares `aliasOf` shares its target's client BY REFERENCE (db.server.ts sets the
 * alias target's own client into the shard map), so a leg for it would scan one database twice and
 * return rows the target's own leg already returned. `RoutingRunStore` drops aliased keys from its
 * store list for exactly this reason, and the discriminator there is the DECLARATION, not object
 * identity — identity cannot tell an alias from its target, and a shard that shares a database
 * WITHOUT declaring it is a misconfiguration the boot sentinel is there to catch, not something to
 * paper over here.
 *
 * Routed lookups keyed by a single id want `runOpsShardReplicas` instead: an aliased key is a
 * legitimate route target, it just is not a second database to scan.
 *
 * Generic in the client type so the caller keeps whatever type its handles carry — no cast.
 */
export function nonAliasedShardReplicas<TClient>(
  handles: ReadonlyArray<{ key: string; replica: TClient; aliasOf?: string }>
): ReadonlyArray<{ key: string; replica: TClient }> {
  return handles
    .filter((handle) => handle.aliasOf === undefined)
    .map((handle) => ({ key: handle.key, replica: handle.replica }));
}

// One resolve, both derivations — `resolveShardHandles` reads a module export behind a try/catch.
const handles = resolveShardHandles();
const maps = buildShardHandleMaps(handles);

export const runOpsShardReplicas = maps.replicas;
export const runOpsShardWriters = maps.writers;
// Empty unless RUN_OPS_SHARDS is configured, which is what keeps every fan-out leg unreachable today.
export const runOpsNonAliasedShardReplicas = nonAliasedShardReplicas(handles);

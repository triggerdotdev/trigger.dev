/**
 * Gen-2 shard client handles, keyed by shard char, for the consumers that route by
 * `resolveShard` outside the run-store boundary: read-through and the two cross-seam
 * batch hydration sites. Both maps are empty unless RUN_OPS_SHARDS is configured, which
 * is what keeps every gen-2 arm unreachable today.
 */
import type { PrismaClient } from "@trigger.dev/database";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaReplicaClient } from "~/db.server";
import { runOpsShardHandles } from "~/db.server";

type ShardHandle = {
  key: string;
  writer: unknown;
  replica: unknown;
};

export function buildShardHandleMaps(handles: ShardHandle[]): {
  replicas: ReadonlyMap<ShardKey, PrismaReplicaClient>;
  writers: ReadonlyMap<ShardKey, PrismaClient>;
} {
  const replicas = new Map<ShardKey, PrismaReplicaClient>();
  const writers = new Map<ShardKey, PrismaClient>();
  for (const handle of handles) {
    replicas.set(handle.key, handle.replica as PrismaReplicaClient);
    writers.set(handle.key, handle.writer as PrismaClient);
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

const maps = buildShardHandleMaps(resolveShardHandles());

export const runOpsShardReplicas = maps.replicas;
export const runOpsShardWriters = maps.writers;

import { resolveShard, type ShardKey } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaReplicaClient } from "~/db.server";
import {
  runOpsLegacyReplica as defaultLegacyReplica,
  runOpsNewPrisma as defaultNewPrimary,
  runOpsNewReplica as defaultNewClient,
  runOpsSplitReadEnabled as defaultSplitReadEnabled,
} from "~/db.server";
import {
  runOpsShardReplicas as defaultShardReplicas,
  runOpsShardWriters as defaultShardWriters,
} from "~/v3/runOpsMigration/shardHandles.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";

type ResolveWaitpointDeps = {
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  newPrimary?: PrismaReplicaClient;
  shardReplicas?: ReadonlyMap<ShardKey, PrismaReplicaClient>;
  shardWriters?: ReadonlyMap<ShardKey, PrismaReplicaClient>;
  splitEnabled?: boolean;
  isPastRetention?: (id: string) => boolean;
};

// Safe defaults matching the deps `complete`/`callback` pass, so a bare caller still fans
// out to the dedicated run-ops replica (NEW-resident waitpoints) before control-plane.
export type ResolveWaitpointReadThroughDefaults = {
  newClient: PrismaReplicaClient;
  legacyReplica: PrismaReplicaClient;
  newPrimary: PrismaReplicaClient;
  shardReplicas: ReadonlyMap<ShardKey, PrismaReplicaClient>;
  shardWriters: ReadonlyMap<ShardKey, PrismaReplicaClient>;
  splitEnabled: boolean;
};

const productionDefaults: ResolveWaitpointReadThroughDefaults = {
  newClient: defaultNewClient,
  legacyReplica: defaultLegacyReplica,
  newPrimary: defaultNewPrimary as unknown as PrismaReplicaClient,
  shardReplicas: defaultShardReplicas,
  shardWriters: defaultShardWriters as unknown as ReadonlyMap<ShardKey, PrismaReplicaClient>,
  splitEnabled: defaultSplitReadEnabled,
};

export async function resolveWaitpointThroughReadThrough<T>(opts: {
  waitpointId: string;
  environmentId: string;
  read: (client: PrismaReplicaClient) => Promise<T | null>;
  deps?: ResolveWaitpointDeps;
  defaults?: ResolveWaitpointReadThroughDefaults;
}): Promise<T | null> {
  const defaults = opts.defaults ?? productionDefaults;

  const splitEnabled = opts.deps?.splitEnabled ?? defaults.splitEnabled;

  const result = await readThroughRun({
    id: opts.waitpointId,
    idKind: "waitpoint",
    environmentId: opts.environmentId,
    readNew: (client) => opts.read(client),
    readLegacy: (replica) => opts.read(replica),
    deps: {
      splitEnabled,
      newClient: opts.deps?.newClient ?? defaults.newClient,
      legacyReplica: opts.deps?.legacyReplica ?? defaults.legacyReplica,
      shardReplicas: opts.deps?.shardReplicas ?? defaults.shardReplicas,
      isPastRetention: opts.deps?.isPastRetention,
    },
  });

  if (result.found) {
    return result.value;
  }
  // past-retention is an intentional not-found: the token is gone.
  if (result.reason === "past-retention") {
    return null;
  }

  // Read-your-writes fallback for a token completed immediately after mint, before it replicated:
  // re-read from the owning store's PRIMARY only. We deliberately never read the control-plane/legacy
  // primary here (that is the load the replica-only read-through exists to shed), so a legacy-resident
  // token that misses its replica stays a miss and the caller retries, rather than adding primary load.
  const shardKey = resolveShard(opts.waitpointId);
  if (shardKey !== "new" && shardKey !== "legacy") {
    // A gen-2 token's primary is its OWN shard's writer. The gen-1 new writer is a different
    // database, so reading it would miss and silently disable read-your-writes here.
    const shardWriter = (opts.deps?.shardWriters ?? defaults.shardWriters).get(shardKey);
    return shardWriter ? await opts.read(shardWriter) : null;
  }

  const fromNewPrimary = await opts.read(opts.deps?.newPrimary ?? defaults.newPrimary);
  if (fromNewPrimary != null) {
    return fromNewPrimary;
  }
  return null;
}

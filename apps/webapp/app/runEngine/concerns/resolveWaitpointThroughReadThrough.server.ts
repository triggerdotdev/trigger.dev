import type { PrismaReplicaClient } from "~/db.server";
import {
  $replica as defaultLegacyReplica,
  runOpsLegacyPrisma as defaultLegacyPrimary,
  runOpsNewPrisma as defaultNewPrimary,
  runOpsNewReplica as defaultNewClient,
  runOpsSplitReadEnabled as defaultSplitReadEnabled,
} from "~/db.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";

type ResolveWaitpointDeps = {
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  newPrimary?: PrismaReplicaClient;
  legacyPrimary?: PrismaReplicaClient;
  splitEnabled?: boolean;
  isPastRetention?: (id: string) => boolean;
};

// Safe defaults matching the deps `complete`/`callback` pass, so a bare caller still fans
// out to the dedicated run-ops replica (NEW-resident waitpoints) before control-plane.
export type ResolveWaitpointReadThroughDefaults = {
  newClient: PrismaReplicaClient;
  legacyReplica: PrismaReplicaClient;
  newPrimary: PrismaReplicaClient;
  legacyPrimary: PrismaReplicaClient;
  splitEnabled: boolean;
};

const productionDefaults: ResolveWaitpointReadThroughDefaults = {
  newClient: defaultNewClient,
  legacyReplica: defaultLegacyReplica,
  newPrimary: defaultNewPrimary as unknown as PrismaReplicaClient,
  legacyPrimary: defaultLegacyPrimary as unknown as PrismaReplicaClient,
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
    runId: opts.waitpointId,
    environmentId: opts.environmentId,
    readNew: (client) => opts.read(client),
    readLegacy: (replica) => opts.read(replica),
    deps: {
      splitEnabled,
      newClient: opts.deps?.newClient ?? defaults.newClient,
      legacyReplica: opts.deps?.legacyReplica ?? defaults.legacyReplica,
      isPastRetention: opts.deps?.isPastRetention,
    },
  });

  if (result.source === "new" || result.source === "legacy-replica") {
    return result.value;
  }
  // past-retention is an intentional not-found: the token is gone, don't hit the primary.
  if (result.source === "past-retention") {
    return null;
  }

  // Read-your-writes fallback: readThroughRun is replica-only, so a token completed immediately after
  // it was minted can miss on the replicas (not yet applied) and 404 a valid token - and the
  // authoritative completeWaitpoint never runs. Re-read from the owning-store PRIMARY (new then legacy)
  // before giving up. Bounded to this replica-miss; a genuinely-absent token still returns null.
  const fromNewPrimary = await opts.read(opts.deps?.newPrimary ?? defaults.newPrimary);
  if (fromNewPrimary != null) {
    return fromNewPrimary;
  }
  if (splitEnabled) {
    const fromLegacyPrimary = await opts.read(opts.deps?.legacyPrimary ?? defaults.legacyPrimary);
    if (fromLegacyPrimary != null) {
      return fromLegacyPrimary;
    }
  }
  return null;
}

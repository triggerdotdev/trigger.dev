import type { PrismaReplicaClient } from "~/db.server";
import {
  $replica as defaultLegacyReplica,
  runOpsNewReplica as defaultNewClient,
  runOpsSplitReadEnabled as defaultSplitReadEnabled,
} from "~/db.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";

type ResolveWaitpointDeps = {
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  splitEnabled?: boolean;
  isPastRetention?: (id: string) => boolean;
};

// Safe defaults matching the deps `complete`/`callback` pass, so a bare caller still fans
// out to the dedicated run-ops replica (NEW-resident waitpoints) before control-plane.
export type ResolveWaitpointReadThroughDefaults = {
  newClient: PrismaReplicaClient;
  legacyReplica: PrismaReplicaClient;
  splitEnabled: boolean;
};

const productionDefaults: ResolveWaitpointReadThroughDefaults = {
  newClient: defaultNewClient,
  legacyReplica: defaultLegacyReplica,
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

  const result = await readThroughRun({
    runId: opts.waitpointId,
    environmentId: opts.environmentId,
    readNew: (client) => opts.read(client),
    readLegacy: (replica) => opts.read(replica),
    deps: {
      splitEnabled: opts.deps?.splitEnabled ?? defaults.splitEnabled,
      newClient: opts.deps?.newClient ?? defaults.newClient,
      legacyReplica: opts.deps?.legacyReplica ?? defaults.legacyReplica,
      isPastRetention: opts.deps?.isPastRetention,
    },
  });

  return result.source === "new" || result.source === "legacy-replica" ? result.value : null;
}

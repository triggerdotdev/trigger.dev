import type { PrismaReplicaClient } from "~/db.server";
import { $replica } from "~/db.server";
import { readThroughRun } from "~/v3/runOpsMigration/readThrough.server";

type ResolveWaitpointDeps = {
  newClient?: PrismaReplicaClient;
  legacyReplica?: PrismaReplicaClient;
  splitEnabled?: boolean;
  isPastRetention?: (id: string) => boolean;
};

export async function resolveWaitpointThroughReadThrough<T>(opts: {
  waitpointId: string;
  environmentId: string;
  read: (client: PrismaReplicaClient) => Promise<T | null>;
  deps?: ResolveWaitpointDeps;
}): Promise<T | null> {
  const result = await readThroughRun({
    runId: opts.waitpointId,
    environmentId: opts.environmentId,
    readNew: (client) => opts.read(client),
    readLegacy: (replica) => opts.read(replica),
    deps: {
      splitEnabled: opts.deps?.splitEnabled,
      newClient: opts.deps?.newClient ?? $replica,
      legacyReplica: opts.deps?.legacyReplica ?? $replica,
      isPastRetention: opts.deps?.isPastRetention,
    },
  });

  return result.source === "new" || result.source === "legacy-replica" ? result.value : null;
}

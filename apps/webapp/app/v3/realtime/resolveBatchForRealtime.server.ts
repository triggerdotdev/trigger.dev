import { prisma } from "~/db.server";
import { runStore } from "~/v3/runStore.server";

type BatchStore = Pick<typeof runStore, "findBatchTaskRunByFriendlyId">;

// The realtime batch route reads the batch client-less (replica), which can miss a just-created batch
// under replica lag. `shouldRetryNotFound` covers the zodfetch GET, but the Electric ShapeStream
// consumer (self-hosters) ignores `x-should-retry`, so re-read the owning primary on a miss — passing a
// non-replica writer flips each store leg to its own primary — to avoid a permanent 404.
export function resolveBatchTaskRunForRealtime(
  friendlyId: string,
  environmentId: string,
  deps?: { store?: BatchStore; writer?: unknown }
) {
  const store = deps?.store ?? runStore;
  const writer = deps?.writer ?? prisma;
  return store
    .findBatchTaskRunByFriendlyId(friendlyId, environmentId)
    .then(
      (onReplica) =>
        onReplica ??
        store.findBatchTaskRunByFriendlyId(friendlyId, environmentId, undefined, writer as never)
    );
}

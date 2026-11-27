import { MEMORYDB_SHARD_KEY, UnknownShardKey } from "@internal/run-store";
import { resolveShard } from "@trigger.dev/core/v3/isomorphic";
import { runStoreRoutesByShard } from "~/v3/runStore.server";

// True for a parent id on `m` when the run store is the routing store (both run-ops URLs set,
// whatever split reads say). Otherwise the run store is one Postgres store, which answers a look-up
// of an `m` id with nothing, so every caller keeps the answer it gives such a parent today. Checks
// the id first: any other id shape reads nothing more.
export function isMemoryDbParent(parentRunId: string): boolean {
  return resolveShard(parentRunId) === MEMORYDB_SHARD_KEY && runStoreRoutesByShard;
}

// A child or batch of a MemoryDB parent is created only when a look-up found that parent. Called
// after a look-up found nothing, this throws the routing store's own error for a look-up by id on
// an unconfigured shard, so every route keeps the answer it gives a parent on `m` today. It reads
// only the id and the store check: any other parent returns, and its caller goes on as before.
export function refuseMemoryDbParentNotFound(parentRunId: string): void {
  if (isMemoryDbParent(parentRunId)) {
    throw new UnknownShardKey(MEMORYDB_SHARD_KEY, []);
  }
}

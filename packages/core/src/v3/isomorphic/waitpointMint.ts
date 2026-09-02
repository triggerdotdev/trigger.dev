import { generateRunOpsIdV2, WaitpointId } from "./friendlyId.js";
import { resolveShard, type ShardKey } from "./runOpsResidency.js";

// A Postgres waitpoint id, not the Redis store format (version "w"), which has no row to route.
// The core is always fresh, or the body would equal the anchor's own id.
export function mintWaitpointIdForShard(key: ShardKey): { id: string; friendlyId: string } {
  if (key === "new" || key === "legacy") {
    return WaitpointId.generate();
  }

  const id = generateRunOpsIdV2(key);
  return { id, friendlyId: WaitpointId.toFriendlyId(id) };
}

// Every Postgres waitpoint mint goes through here: the router refuses an unstamped id on a shard.
export function mintWaitpointIdFor(anchorId: string | undefined): {
  id: string;
  friendlyId: string;
} {
  return anchorId === undefined
    ? WaitpointId.generate()
    : mintWaitpointIdForShard(resolveShard(anchorId));
}

import { generateRunOpsIdV2, WaitpointId } from "./friendlyId.js";
import { resolveShard, type ShardKey } from "./runOpsResidency.js";

// A Postgres waitpoint id, NOT the Redis store format (version "w" at index 25), which has no
// Postgres row to route. The core is always fresh, or the body would equal the anchor's own id.
export function mintWaitpointIdForShard(key: ShardKey): { id: string; friendlyId: string } {
  if (key === "new" || key === "legacy") {
    return WaitpointId.generate();
  }

  const id = generateRunOpsIdV2(key);
  return { id, friendlyId: WaitpointId.toFriendlyId(id) };
}

// Every Postgres waitpoint mint goes through here: the router refuses an id that is not stamped
// for the shard it lands on. A gen-1 or legacy anchor keeps a cuid.
export function mintWaitpointIdFor(anchorId: string | undefined): {
  id: string;
  friendlyId: string;
} {
  return anchorId === undefined
    ? WaitpointId.generate()
    : mintWaitpointIdForShard(resolveShard(anchorId));
}

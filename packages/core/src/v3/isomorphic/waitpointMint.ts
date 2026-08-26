import { generateRunOpsIdV2, WaitpointId } from "./friendlyId.js";
import { resolveShard, type ShardKey } from "./runOpsResidency.js";

// A waitpoint id for a Postgres shard — NOT the Redis store format (type char at index
// 24, version "w"), which has no Postgres row to route. The core is always fresh: reusing
// the anchor's would produce a body identical to the run's own id.
export function mintWaitpointIdForShard(key: ShardKey): { id: string; friendlyId: string } {
  if (key === "new" || key === "legacy") {
    return WaitpointId.generate();
  }

  const id = generateRunOpsIdV2(key);
  return { id, friendlyId: WaitpointId.toFriendlyId(id) };
}

// Every Postgres waitpoint mint goes through here, in the webapp and the engine alike:
// the router refuses a waitpoint whose id is not stamped for the shard it lands on.
// A gen-1 or legacy anchor keeps a cuid.
export function mintWaitpointIdFor(anchorId: string | undefined): {
  id: string;
  friendlyId: string;
} {
  return anchorId === undefined
    ? WaitpointId.generate()
    : mintWaitpointIdForShard(resolveShard(anchorId));
}

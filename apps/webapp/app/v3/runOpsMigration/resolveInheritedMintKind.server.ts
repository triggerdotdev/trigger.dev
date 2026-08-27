import { resolveShard } from "@trigger.dev/core/v3/isomorphic";
import type { MintTarget } from "./mintTarget";

// Mint a child in the SAME physical store as its anchor (parent run / owning batch),
// regardless of the org's current mint flag — keeps a subgraph co-resident across a
// flip. With no migration/drain, residency is a pure id-shape check (zero hot-path
// I/O): a run-ops (NEW) parent mints run-ops children, a cuid (LEGACY) parent mints cuid.
// A gen-2 parent hands down its OWN shard char, never a freshly resolved one: two runs in
// one tree must never split across shards.
export function resolveInheritedMintKind(parentRunFriendlyId: string): MintTarget {
  const shard = resolveShard(parentRunFriendlyId);

  if (shard === "legacy") return { kind: "cuid" };
  if (shard === "new") return { kind: "runOpsId" };
  return { kind: "runOpsId", shardChar: shard };
}

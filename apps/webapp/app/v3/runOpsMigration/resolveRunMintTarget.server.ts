import type { MintTarget } from "./mintTarget";
import { resolveInheritedMintKind } from "./resolveInheritedMintKind.server";
import { resolveRunIdMintKind as defaultResolveRunIdMintKind } from "./runOpsMintKind.server";
import { resolveMintShard as defaultResolveMintShard } from "./runOpsMintShard.server";

export type RunMintDeps = {
  resolveRunIdMintKind: typeof defaultResolveRunIdMintKind;
  resolveMintShard: typeof defaultResolveMintShard;
};

const defaultDeps: RunMintDeps = {
  resolveRunIdMintKind: defaultResolveRunIdMintKind,
  resolveMintShard: defaultResolveMintShard,
};

/**
 * Where one run mints. The second stage runs only for a root run already on the run-ops path: a
 * child inherits its parent's shard by id-shape, so a tree never splits across shards.
 */
export async function resolveRunMintTarget(args: {
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown };
  parentRunFriendlyId?: string;
  region?: string;
  deps?: Partial<RunMintDeps>;
}): Promise<MintTarget> {
  if (args.parentRunFriendlyId) {
    // The region still travels: it takes index 24 for an inherited gen-1 parent, and a gen-2
    // parent's shardChar outranks it.
    return { ...resolveInheritedMintKind(args.parentRunFriendlyId), region: args.region };
  }

  const deps = { ...defaultDeps, ...args.deps };

  const kind = await deps.resolveRunIdMintKind({
    organizationId: args.environment.organizationId,
    id: args.environment.id,
    orgFeatureFlags: args.environment.orgFeatureFlags,
  });

  if (kind !== "runOpsId") {
    return { kind };
  }

  const shard = await deps.resolveMintShard({
    id: args.environment.id,
    orgFeatureFlags: args.environment.orgFeatureFlags,
  });

  // A reserved key means gen-1, the state of every deployment with no shard configured.
  return shard === "new" || shard === "legacy"
    ? { kind, region: args.region }
    : { kind, shardChar: shard, region: args.region };
}

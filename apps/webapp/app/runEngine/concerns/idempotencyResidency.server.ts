import { resolveShard, RunId, type ShardKey } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClientOrTransaction } from "@trigger.dev/database";

type MintKind = "cuid" | "runOpsId";

type Logger = { error: (message: string, meta?: Record<string, unknown>) => void };

export type ResolveIdempotencyClientDeps = {
  isSplitEnabled: () => Promise<boolean>;
  fallbackClient: PrismaClientOrTransaction;
  /** Every store keyed by shard key: the reserved `legacy`/`new` plus one entry per gen-2 shard. */
  clients: ReadonlyMap<ShardKey, PrismaClientOrTransaction>;
  resolveMintKind: (environment: {
    organizationId: string;
    id: string;
    orgFeatureFlags?: unknown;
  }) => Promise<MintKind>;
  classify?: (id: string) => ShardKey;
  logger?: Logger;
};

/**
 * The one place an id becomes a client. `ShardKey` collapses to `string`, so the compiler
 * cannot catch a wrong key here — an absent key takes an explicit logged branch to the
 * fallback rather than a silent `?? legacy`.
 */
export function clientForShardKey(
  shardKey: ShardKey,
  clients: ReadonlyMap<ShardKey, PrismaClientOrTransaction>,
  fallback: PrismaClientOrTransaction,
  logger?: Logger
): PrismaClientOrTransaction {
  const client = clients.get(shardKey);
  if (client === undefined) {
    logger?.error("idempotency: no client configured for shard key", {
      shardKey,
      configured: [...clients.keys()],
    });
    return fallback;
  }
  return client;
}

export async function resolveIdempotencyDedupClient(
  args: {
    environmentForMint: { organizationId: string; id: string; orgFeatureFlags?: unknown };
    parentRunFriendlyId: string | undefined;
  },
  deps: ResolveIdempotencyClientDeps
): Promise<PrismaClientOrTransaction> {
  if (!(await deps.isSplitEnabled())) {
    return deps.fallbackClient;
  }

  const classify = deps.classify ?? resolveShard;
  const clientFor = (shardKey: ShardKey): PrismaClientOrTransaction =>
    clientForShardKey(shardKey, deps.clients, deps.fallbackClient, deps.logger);

  if (args.parentRunFriendlyId) {
    let parentInternalId: string;
    try {
      parentInternalId = RunId.fromFriendlyId(args.parentRunFriendlyId);
    } catch {
      return deps.fallbackClient;
    }
    let shardKey: ShardKey;
    try {
      shardKey = classify(parentInternalId);
    } catch {
      return deps.fallbackClient;
    }
    return clientFor(shardKey);
  }

  // Mint kind, not an id: there is no shard to decode, so this keeps resolving to the
  // gen-1 pair exactly as before. Which shard a gen-2 env mints into is the mint layer's
  // decision, and this client is a read-your-writes signal rather than a correctness gate.
  const kind = await deps.resolveMintKind(args.environmentForMint);
  return clientFor(kind === "runOpsId" ? "new" : "legacy");
}

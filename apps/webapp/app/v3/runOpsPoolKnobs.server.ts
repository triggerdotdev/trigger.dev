import { env } from "~/env.server";
import type { RunOpsShardKnobs } from "~/v3/runOpsShards.server";

// Pool configuration for one run-ops store (writer + replica), resolved at the app boundary (IoC).
// Every value reproduces today's run-ops builder expressions. Kept separate from db.server (which
// ~156 tests mock wholesale) so a new export breaks no mock.
export type ResolvedPoolKnobs = {
  writerPoolTimeout: number;
  writerConnectionTimeout: number;
  writerDriverAdapter: boolean;
  connectionLimit: number;
  replicaConnectionLimit: number;
  replicaPoolTimeout: number;
  replicaConnectionTimeout: number;
  replicaDriverAdapter: boolean;
};

type Role = "new" | "legacy";

// Resolve the pool knobs for a run-ops role, reproducing today's builder expressions exactly.
// descriptorKnobs (gen-2 shards only) override the pool fields.
// Transaction resilience is a SEPARATE mechanism (resolveTransactionResilience) and is not here.
export function resolveRunOpsPoolKnobs(
  role: Role,
  descriptorKnobs?: RunOpsShardKnobs
): ResolvedPoolKnobs {
  const k = descriptorKnobs;

  if (role === "legacy") {
    return {
      writerPoolTimeout:
        k?.writerPoolTimeout ??
        env.RUN_OPS_LEGACY_DATABASE_WRITER_POOL_TIMEOUT ??
        env.DATABASE_POOL_TIMEOUT,
      writerConnectionTimeout:
        k?.writerConnectionTimeout ??
        env.RUN_OPS_LEGACY_DATABASE_WRITER_CONNECTION_TIMEOUT ??
        env.DATABASE_CONNECTION_TIMEOUT,
      writerDriverAdapter:
        k?.writerDriverAdapter ?? env.RUN_OPS_LEGACY_DATABASE_WRITER_DRIVER_ADAPTER === "1",
      connectionLimit: k?.connectionLimit ?? env.DATABASE_CONNECTION_LIMIT,
      replicaConnectionLimit: k?.replicaConnectionLimit ?? env.DATABASE_CONNECTION_LIMIT,
      replicaPoolTimeout:
        k?.replicaPoolTimeout ??
        env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_POOL_TIMEOUT ??
        env.DATABASE_POOL_TIMEOUT,
      replicaConnectionTimeout:
        k?.replicaConnectionTimeout ??
        env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_CONNECTION_TIMEOUT ??
        env.DATABASE_CONNECTION_TIMEOUT,
      replicaDriverAdapter:
        k?.replicaDriverAdapter ?? env.RUN_OPS_LEGACY_DATABASE_REPLICA_DRIVER_ADAPTER === "1",
    };
  }

  return {
    writerPoolTimeout:
      k?.writerPoolTimeout ??
      env.RUN_OPS_DATABASE_WRITER_POOL_TIMEOUT ??
      env.DATABASE_POOL_TIMEOUT,
    writerConnectionTimeout:
      k?.writerConnectionTimeout ??
      env.RUN_OPS_DATABASE_WRITER_CONNECTION_TIMEOUT ??
      env.DATABASE_CONNECTION_TIMEOUT,
    writerDriverAdapter:
      k?.writerDriverAdapter ?? env.RUN_OPS_DATABASE_WRITER_DRIVER_ADAPTER === "1",
    connectionLimit: k?.connectionLimit ?? env.DATABASE_CONNECTION_LIMIT,
    replicaConnectionLimit:
      k?.replicaConnectionLimit ??
      env.RUN_OPS_DATABASE_READ_REPLICA_CONNECTION_LIMIT ??
      env.DATABASE_CONNECTION_LIMIT,
    replicaPoolTimeout:
      k?.replicaPoolTimeout ??
      env.RUN_OPS_DATABASE_READ_REPLICA_POOL_TIMEOUT ??
      env.DATABASE_POOL_TIMEOUT,
    replicaConnectionTimeout:
      k?.replicaConnectionTimeout ??
      env.RUN_OPS_DATABASE_READ_REPLICA_CONNECTION_TIMEOUT ??
      env.DATABASE_CONNECTION_TIMEOUT,
    replicaDriverAdapter:
      k?.replicaDriverAdapter ?? env.RUN_OPS_DATABASE_REPLICA_DRIVER_ADAPTER === "1",
  };
}

import { env } from "~/env.server";
import type { RunOpsShardKnobs } from "~/v3/runOpsShards.server";

// Pool configuration for one run-ops store (writer + replica). Kept separate from db.server (which
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

// PURE: overlay a gen-2 shard's descriptor knobs on a role's resolved defaults. This holds the only
// logic (per-field override), so a test drives it with literal defaults and literal overrides —
// no env import, no circular assertion against the same env expression the impl reads.
export function applyPoolKnobOverrides(
  defaults: ResolvedPoolKnobs,
  k?: RunOpsShardKnobs
): ResolvedPoolKnobs {
  return {
    writerPoolTimeout: k?.writerPoolTimeout ?? defaults.writerPoolTimeout,
    writerConnectionTimeout: k?.writerConnectionTimeout ?? defaults.writerConnectionTimeout,
    writerDriverAdapter: k?.writerDriverAdapter ?? defaults.writerDriverAdapter,
    connectionLimit: k?.connectionLimit ?? defaults.connectionLimit,
    replicaConnectionLimit: k?.replicaConnectionLimit ?? defaults.replicaConnectionLimit,
    replicaPoolTimeout: k?.replicaPoolTimeout ?? defaults.replicaPoolTimeout,
    replicaConnectionTimeout: k?.replicaConnectionTimeout ?? defaults.replicaConnectionTimeout,
    replicaDriverAdapter: k?.replicaDriverAdapter ?? defaults.replicaDriverAdapter,
  };
}

// The env-derived defaults for a role, reproducing today's run-ops builder expressions exactly. A
// flat mapping (no logic), verified by inspection against the former builders. Transaction
// resilience is a SEPARATE mechanism (resolveTransactionResilience) and is not here.
function poolKnobDefaults(role: Role): ResolvedPoolKnobs {
  if (role === "legacy") {
    return {
      writerPoolTimeout:
        env.RUN_OPS_LEGACY_DATABASE_WRITER_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT,
      writerConnectionTimeout:
        env.RUN_OPS_LEGACY_DATABASE_WRITER_CONNECTION_TIMEOUT ?? env.DATABASE_CONNECTION_TIMEOUT,
      writerDriverAdapter: env.RUN_OPS_LEGACY_DATABASE_WRITER_DRIVER_ADAPTER === "1",
      connectionLimit: env.DATABASE_CONNECTION_LIMIT,
      replicaConnectionLimit: env.DATABASE_CONNECTION_LIMIT,
      replicaPoolTimeout:
        env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT,
      replicaConnectionTimeout:
        env.RUN_OPS_LEGACY_DATABASE_READ_REPLICA_CONNECTION_TIMEOUT ??
        env.DATABASE_CONNECTION_TIMEOUT,
      replicaDriverAdapter: env.RUN_OPS_LEGACY_DATABASE_REPLICA_DRIVER_ADAPTER === "1",
    };
  }

  return {
    writerPoolTimeout: env.RUN_OPS_DATABASE_WRITER_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT,
    writerConnectionTimeout:
      env.RUN_OPS_DATABASE_WRITER_CONNECTION_TIMEOUT ?? env.DATABASE_CONNECTION_TIMEOUT,
    writerDriverAdapter: env.RUN_OPS_DATABASE_WRITER_DRIVER_ADAPTER === "1",
    connectionLimit: env.DATABASE_CONNECTION_LIMIT,
    replicaConnectionLimit:
      env.RUN_OPS_DATABASE_READ_REPLICA_CONNECTION_LIMIT ?? env.DATABASE_CONNECTION_LIMIT,
    replicaPoolTimeout: env.RUN_OPS_DATABASE_READ_REPLICA_POOL_TIMEOUT ?? env.DATABASE_POOL_TIMEOUT,
    replicaConnectionTimeout:
      env.RUN_OPS_DATABASE_READ_REPLICA_CONNECTION_TIMEOUT ?? env.DATABASE_CONNECTION_TIMEOUT,
    replicaDriverAdapter: env.RUN_OPS_DATABASE_REPLICA_DRIVER_ADAPTER === "1",
  };
}

export function resolveRunOpsPoolKnobs(
  role: Role,
  descriptorKnobs?: RunOpsShardKnobs
): ResolvedPoolKnobs {
  return applyPoolKnobOverrides(poolKnobDefaults(role), descriptorKnobs);
}

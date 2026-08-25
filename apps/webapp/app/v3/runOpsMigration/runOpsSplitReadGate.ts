// Pure run-ops split READ gate. Track 2: the legacy handle is now its OWN independent client (not the
// control-plane client), so this gate keys purely on the NEW replica being a distinct dedicated client
// from BOTH control-plane handles — else fan-out would just re-read the control-plane DB. Keeping
// replica reads off primaries for all three roles is markReadReplicaClient's job, not this boolean's.
export function computeRunOpsSplitReadEnabled(args: {
  newReplica: unknown;
  controlPlaneWriter: unknown;
  controlPlaneReplica: unknown;
  hasNewUrl: boolean;
  hasLegacyUrl: boolean;
  /**
   * Gen-2 shard replica handles. Observability only: a non-distinct shard handle WARNS and never
   * changes the returned verdict. The distinctness sentinel already fail-closes the boot on the
   * same condition, and a gen-2 fault must not disable the proven gen-1 read fan-out as well.
   */
  shardHandles?: Array<{ key: string; replica: unknown; aliasOf?: "new" }>;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}): boolean {
  const newIsDistinctDedicatedClient =
    args.newReplica !== args.controlPlaneWriter && args.newReplica !== args.controlPlaneReplica;

  const enabled = newIsDistinctDedicatedClient && args.hasNewUrl && args.hasLegacyUrl;

  // Configured for split but the identity check failed: fan-out is being silently disabled.
  if (!newIsDistinctDedicatedClient && args.hasNewUrl && args.hasLegacyUrl) {
    args.logger?.warn(
      "run-ops split read fan-out is configured (RUN_OPS_DATABASE_URL and " +
        "RUN_OPS_LEGACY_DATABASE_URL are both set) but the NEW client is not a distinct " +
        "instance from the control-plane client; read fan-out is silently disabled."
    );
  }

  // An aliased shard shares its target's client by reference, so identity equality is its correct
  // state and never a fault. Keyed on the declared field, not on object identity.
  for (const shard of args.shardHandles ?? []) {
    if (shard.aliasOf !== undefined) continue;
    if (
      shard.replica === args.controlPlaneWriter ||
      shard.replica === args.controlPlaneReplica ||
      shard.replica === args.newReplica
    ) {
      args.logger?.warn(
        `run-ops shard ${shard.key} declares its own database but its replica client is not a ` +
          "distinct instance from the control-plane or gen-1 new client; reads for that shard " +
          "would not reach its database."
      );
    }
  }

  return enabled;
}

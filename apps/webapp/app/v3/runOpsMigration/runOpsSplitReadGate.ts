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

  return enabled;
}

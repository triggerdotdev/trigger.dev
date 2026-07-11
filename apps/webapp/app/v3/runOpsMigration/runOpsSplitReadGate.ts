// Pure run-ops split READ gate. The LEGACY handle is intentionally the control-plane client,
// so only the NEW client's distinctness gates (see runOpsSplitReadGate.test.ts).
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

// Pure run-ops split READ gate. The LEGACY handle is intentionally the control-plane client,
// so only the NEW client's distinctness gates (see runOpsSplitReadGate.test.ts).
export function computeRunOpsSplitReadEnabled(args: {
  newReplica: unknown;
  controlPlaneWriter: unknown;
  controlPlaneReplica: unknown;
  hasNewUrl: boolean;
  hasLegacyUrl: boolean;
}): boolean {
  const newIsDistinctDedicatedClient =
    args.newReplica !== args.controlPlaneWriter && args.newReplica !== args.controlPlaneReplica;

  return newIsDistinctDedicatedClient && args.hasNewUrl && args.hasLegacyUrl;
}

// Bounds per-org metric cardinality to exactly two series. A cohort member is labelled "cohort" and
// everything else (undefined included) "other", so the series count never grows with the cohort. Never
// emit the organizationId itself: it is unbounded at rollout and violates the no-high-cardinality-label
// rule. Per-org investigation belongs in traces/logs filtered by orgId, not in a metric label.
export function cohortMetricLabel(
  organizationId: string | undefined,
  isCohortMember: (organizationId: string) => boolean
): string {
  return organizationId !== undefined && isCohortMember(organizationId) ? "cohort" : "other";
}

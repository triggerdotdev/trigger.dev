// Bounds per-org metric cardinality: only cohort members get a distinct label, everything else
// (undefined included) collapses to "other" — at most cohort size plus one series.
export function cohortMetricLabel(
  organizationId: string | undefined,
  isCohortMember: (organizationId: string) => boolean
): string {
  return organizationId !== undefined && isCohortMember(organizationId) ? organizationId : "other";
}

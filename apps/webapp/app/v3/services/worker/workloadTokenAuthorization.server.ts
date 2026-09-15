/**
 * The no-header created-at gate. Tenant scoping is handled by the env-scoped snapshot read in the
 * engine; this only covers the fallback where no verified env header was forwarded (caller predates
 * tokens, or the supervisor isn't enforcing):
 *
 *   run created on/before cutoff -> allow (grandfather legacy untokened runs)
 *   run created after cutoff     -> reject (a new-enough run should have carried a token)
 *
 * Pure and env-import-free so it stays trivially testable.
 */

type CreatedAtGateOutcome = "grandfathered" | "suppressed";

export type CreatedAtGateEvaluation = {
  outcome: CreatedAtGateOutcome;
  allow: boolean;
};

export function evaluateCreatedAtGate(params: {
  runCreatedAt: Date;
  cutoff: Date;
}): CreatedAtGateEvaluation {
  const createdAfterCutoff = params.runCreatedAt.getTime() > params.cutoff.getTime();
  return createdAfterCutoff
    ? { outcome: "suppressed", allow: false }
    : { outcome: "grandfathered", allow: true };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const RUN_AGE_BUCKETS = [
  { under: HOUR_MS, label: "lt_1h" },
  { under: DAY_MS, label: "1h_1d" },
  { under: 7 * DAY_MS, label: "1d_7d" },
  { under: 30 * DAY_MS, label: "7d_30d" },
] as const;

/**
 * Coarse age of the run behind an untokened worker action. Reading this while the cutoff is set far
 * in the future answers "what would a cutoff of X reject" without rejecting anything.
 */
export function runAgeBucket(runCreatedAt: Date, now: Date): string {
  const ageMs = now.getTime() - runCreatedAt.getTime();
  return RUN_AGE_BUCKETS.find((bucket) => ageMs < bucket.under)?.label ?? "gt_30d";
}

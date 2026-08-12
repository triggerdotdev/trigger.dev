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

export type CreatedAtGateOutcome = "grandfathered" | "suppressed";

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

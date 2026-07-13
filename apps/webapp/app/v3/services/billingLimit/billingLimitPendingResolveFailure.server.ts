export type PendingBillingLimitResolveFailureClass =
  | "cancel-failing"
  | "converge-failing"
  | "ack-only";

/** Used in converge logs to classify stuck pending resolves. */
export function classifyPendingBillingLimitResolveConvergeFailure(
  resumeMode: "queue" | "new_only"
): Exclude<PendingBillingLimitResolveFailureClass, "ack-only"> {
  return resumeMode === "new_only" ? "cancel-failing" : "converge-failing";
}

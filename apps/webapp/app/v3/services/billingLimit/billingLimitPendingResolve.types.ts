export type PendingBillingLimitResolve = {
  organizationId: string;
  resumeMode: "queue" | "new_only";
  resolvedAt: string;
};

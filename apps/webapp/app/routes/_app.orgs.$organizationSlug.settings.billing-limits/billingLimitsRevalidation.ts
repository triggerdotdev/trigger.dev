/** Revalidate org layout (billingLimit banner) after billing limits settings forms submit. */
export function isBillingLimitSettingsFormSubmission(
  formMethod: string | undefined,
  formData: FormData | undefined
): boolean {
  if (!formMethod || !formData || formMethod.toLowerCase() !== "post") {
    return false;
  }

  const intent = formData.get("intent");
  return (
    intent === "billing-limit" || intent === "billing-alerts" || intent === "billing-limit-resolve"
  );
}

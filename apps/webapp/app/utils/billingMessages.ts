export const billingMessages = {
  stagingEnvironment: "Upgrade to unlock a Staging environment for your projects.",
  previewEnvironments: "Upgrade to unlock Preview environments for your projects.",
  concurrency: "Upgrade your plan for more concurrency",
  staticIps: "Upgrade your plan to unlock static IPs",
} as const;

export type BillingMessageKey = keyof typeof billingMessages;

export function billingMessageFromKey(key: string | null): string | undefined {
  if (!key || !Object.hasOwn(billingMessages, key)) return;
  return billingMessages[key as BillingMessageKey];
}

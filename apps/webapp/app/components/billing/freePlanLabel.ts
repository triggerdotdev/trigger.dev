import type { SubscriptionResult } from "@trigger.dev/platform";

// Both Stripe and Metronome move a downgraded org to Free on the 1st (UTC).
export function downgradeTakesEffectAt(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function freePlanButtonLabel(subscription?: SubscriptionResult, now = new Date()): string {
  if (subscription?.plan === undefined) return "Select plan";
  if (subscription.plan.type === "free") return "Current plan";
  if (subscription.canceledAt === undefined) return "Select plan";

  const startsAt = downgradeTakesEffectAt(now).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Starts ${startsAt}`;
}

export type MovesToPlan = { code: string; title: string };

// Billing sends the plan an org waiting to move to Metronome is on from the move, in the subscription field.
export function billingMovesToPlanOf(subscription: unknown): MovesToPlan | undefined {
  if (typeof subscription !== "object" || subscription === null) return undefined;
  const movesTo = (subscription as { billingMovesToPlan?: unknown }).billingMovesToPlan;
  if (typeof movesTo !== "object" || movesTo === null) return undefined;
  const { code, title } = movesTo as { code?: unknown; title?: unknown };
  if (typeof code !== "string" || typeof title !== "string") return undefined;
  return { code, title };
}

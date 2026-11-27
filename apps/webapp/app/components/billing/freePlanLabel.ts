import type { PlanDefinition, SubscriptionResult } from "@trigger.dev/platform";

// Both Stripe and Metronome move a downgraded org to Free on the 1st (UTC).
export function downgradeTakesEffectAt(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
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

// paidPlansWait: no paid plan can be picked until the plan starts.
export type ScheduledPlan = MovesToPlan & { startsAt: Date; paidPlansWait?: boolean };

// Metronome keeps the current plan until the 1st and sends the plan waiting for it in the subscription
// field, as for the move to Metronome; the platform schema would drop a new field of its own.
export function scheduledPlanOf(subscription: unknown): ScheduledPlan | undefined {
  if (typeof subscription !== "object" || subscription === null) return undefined;
  const scheduled = (subscription as { scheduledPlan?: unknown }).scheduledPlan;
  if (typeof scheduled !== "object" || scheduled === null) return undefined;
  const { code, title, startsAt } = scheduled as Record<string, unknown>;
  if (typeof code !== "string" || typeof title !== "string" || typeof startsAt !== "string") {
    return undefined;
  }
  return { code, title, startsAt: new Date(startsAt) };
}

// An org waiting to move to Metronome has the plan it moves onto pending, when that differs from today's.
export function pendingPlanOf(
  scheduled: ScheduledPlan | undefined,
  movesAt: Date | undefined,
  movesTo: MovesToPlan | undefined,
  currentCode: string | undefined
): ScheduledPlan | undefined {
  if (scheduled) return scheduled;
  if (!movesAt || !movesTo || movesTo.code === currentCode) return undefined;
  // A move onto Free left the org's discounts and cancel on Stripe: billing refuses paid plans until then.
  return { ...movesTo, startsAt: movesAt, ...(movesTo.code === "free" && { paidPlansWait: true }) };
}

// Set for an org whose downgrades wait for the next 1st; Stripe moves to a lower paid plan at once.
export function downgradesAtOf(subscription: unknown): Date | undefined {
  if (typeof subscription !== "object" || subscription === null) return undefined;
  const at = (subscription as { downgradesAt?: unknown }).downgradesAt;
  return typeof at === "string" ? new Date(at) : undefined;
}

export type PlanButton = { label: string; disabled: boolean; confirm?: "upgrade" | "downgrade" };

const rank = (plan: Pick<PlanDefinition, "type"> & { tierPrice?: number }) =>
  plan.type === "free" ? 0 : plan.type === "enterprise" ? Infinity : (plan.tierPrice ?? 0);

const shortDate = (date: Date) =>
  date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A plan column's button: the org stays on its plan until a scheduled downgrade starts. */
export function planButton(
  plan: PlanDefinition,
  subscription: SubscriptionResult | undefined,
  scheduled: ScheduledPlan | undefined,
  now = new Date()
): PlanButton {
  const current = subscription?.plan;
  if (!current) return { label: "Select plan", disabled: false };

  const pending =
    scheduled ??
    (subscription.canceledAt !== undefined && current.type !== "free"
      ? { code: "free", title: "Free", startsAt: downgradeTakesEffectAt(now) }
      : undefined);

  if (plan.code === pending?.code) {
    return { label: `Starts ${shortDate(pending.startsAt)}`, disabled: true };
  }
  if (pending?.paidPlansWait && plan.type !== "free") {
    return plan.code === current.code
      ? { label: "Current plan", disabled: true }
      : { label: `Available ${shortDate(pending.startsAt)}`, disabled: true };
  }
  if (plan.code === current.code) {
    return pending
      ? { label: `Stay on ${plan.title}`, disabled: false }
      : { label: "Current plan", disabled: true };
  }
  if (rank(plan) > rank(current)) {
    return {
      label: `Upgrade to ${plan.title}`,
      disabled: false,
      ...(current.type === "paid" && { confirm: "upgrade" as const }),
    };
  }
  return { label: `Downgrade to ${plan.title}`, disabled: false, confirm: "downgrade" };
}

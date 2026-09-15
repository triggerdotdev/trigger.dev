import type { Limits } from "@trigger.dev/platform";
import { WATCH_MAX_HOURS } from "@internal/dashboard-agent-contracts";
import { getCachedLimitAllowingZero, isBillingConfigured } from "./platform.v3.server";

// The unlimited sentinel, matching the message quota (TRI-12863 P1). Never Infinity: it
// serializes to null in the limit cache.
export const UNLIMITED_WATCH_LIMIT = 100_000_000;

// Filled by cloud billing (TRI-12863 P0). Absent until then, and always on self-hosted, so
// the fallback applies and the plan floor is off.
const WATCH_MAX_HOURS_LIMIT_KEY = "agentWatchMaxHours" as keyof Limits;
const WATCH_COUNT_LIMIT_KEY = "agentWatchers" as keyof Limits;

export type WatchPlanLimits = {
  /** Longest window one watch may run for, in hours. */
  maxHours: number;
  /** How many active watches the org may run at once. */
  watchers: number;
};

async function readLimit(organizationId: string, key: keyof Limits): Promise<number> {
  // A plan of 0 means zero, not absent: an org with watches switched off must not read as
  // unlimited. Only a missing limit falls open.
  const cached = await getCachedLimitAllowingZero(organizationId, key, UNLIMITED_WATCH_LIMIT);
  // A cache error leaves `val` empty; fall open to unlimited.
  return cached.val ?? UNLIMITED_WATCH_LIMIT;
}

/**
 * The org's plan floors for watches. Fails open: an absent limit (self-hosted, or before the
 * cloud side ships) resolves to the unlimited sentinel, so neither floor bites. `read` is the
 * plan-limit seam: tests pass their own reader instead of the cached platform one.
 */
export async function resolveWatchPlanLimits(
  organizationId: string,
  read: (organizationId: string, key: keyof Limits) => Promise<number> = readLimit
): Promise<WatchPlanLimits> {
  const [maxHours, watchers] = await Promise.all([
    read(organizationId, WATCH_MAX_HOURS_LIMIT_KEY),
    read(organizationId, WATCH_COUNT_LIMIT_KEY),
  ]);
  return { maxHours, watchers };
}

/**
 * The window ceiling actually in force: the plan floor under the code ceiling. A plan that
 * allows 100 hours still caps at {@link WATCH_MAX_HOURS}.
 */
export function effectiveWatchMaxHours(planMaxHours: number): number {
  return Math.min(planMaxHours, WATCH_MAX_HOURS);
}

/**
 * A watch-limit refusal, plus an upgrade nudge when billing is present. Self-hosted never
 * hits this (fails open above), and the nudge is gated so a stray refusal stays quiet there.
 */
export function watchLimitHint(base: string, billingConfigured = isBillingConfigured()): string {
  return billingConfigured ? `${base} Upgrade your plan for more.` : base;
}

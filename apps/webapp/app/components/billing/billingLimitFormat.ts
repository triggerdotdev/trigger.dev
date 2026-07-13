import { formatDurationMilliseconds } from "@trigger.dev/core/v3";

/** Format billing grace period from API `gracePeriodMs` (e.g. 24 hours, not 1 day). */
export function formatGracePeriodMs(ms: number): string {
  return formatDurationMilliseconds(ms, {
    style: "long",
    units: ["h", "m", "s"],
    maxUnits: 1,
  });
}

export function getSuggestedRecoveryLimitDollars(
  effectiveAmountCents: number | null,
  currentSpendCents: number
): number {
  const candidates = [Math.ceil(currentSpendCents * 1.25)];
  if (effectiveAmountCents != null) {
    candidates.push(effectiveAmountCents + 5_000, Math.ceil(effectiveAmountCents * 1.25));
  }

  const rawAmount = Math.max(...candidates) / 100;
  return Math.ceil(rawAmount / 50) * 50;
}

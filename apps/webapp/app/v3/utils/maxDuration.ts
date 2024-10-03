const MINIMUM_MAX_DURATION = 5;
const MAXIMUM_MAX_DURATION = 2_147_483_647; // largest 32-bit signed integer

export function clampMaxDuration(maxDuration: number): number {
  return Math.min(Math.max(maxDuration, MINIMUM_MAX_DURATION), MAXIMUM_MAX_DURATION);
}

export function getMaxDuration(
  maxDuration?: number | null,
  defaultMaxDuration?: number | null
): number | undefined {
  if (!maxDuration) {
    return defaultMaxDuration ?? undefined;
  }

  // Setting the maxDuration to MAXIMUM_MAX_DURATION means we don't want to use the default maxDuration
  if (maxDuration === MAXIMUM_MAX_DURATION) {
    return;
  }

  return maxDuration;
}

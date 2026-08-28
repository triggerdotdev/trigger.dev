const MINIMUM_MAX_DURATION = 5;
const MAXIMUM_MAX_DURATION = 2_147_483_647; // largest 32-bit signed integer

export function clampMaxDuration(maxDuration: number): number {
  return Math.min(Math.max(maxDuration, MINIMUM_MAX_DURATION), MAXIMUM_MAX_DURATION);
}

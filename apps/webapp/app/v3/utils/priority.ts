const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export function clampPriorityMs(priority: number): number {
  return Math.min(Math.max(Math.round(priority * 1_000), INT4_MIN), INT4_MAX);
}

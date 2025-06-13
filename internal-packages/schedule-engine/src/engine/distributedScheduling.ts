/**
 * Calculates a distributed execution time for a scheduled task.
 * Tasks are distributed across a time window before the exact schedule time
 * to prevent thundering herd issues while maintaining schedule accuracy.
 */
export function calculateDistributedExecutionTime(
  exactScheduleTime: Date,
  distributionWindowSeconds: number = 30
): Date {
  // Use the ISO string of the exact schedule time as the seed for consistency
  const seed = exactScheduleTime.toISOString();

  // Create a simple hash from the seed string
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Convert hash to a value between 0 and 1
  const normalized = Math.abs(hash) / Math.pow(2, 31);

  // Calculate offset in milliseconds (0 to distributionWindowSeconds * 1000)
  const offsetMs = Math.floor(normalized * distributionWindowSeconds * 1000);

  // Return time that's offsetMs before the exact schedule time
  return new Date(exactScheduleTime.getTime() - offsetMs);
}

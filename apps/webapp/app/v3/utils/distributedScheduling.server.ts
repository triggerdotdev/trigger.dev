/**
 * Calculates a distributed execution time within the specified distribution window
 * before the exact schedule time. This helps spread the load across time instead of
 * having all scheduled tasks execute at exactly the same moment.
 */
export function calculateDistributedExecutionTime(
  exactScheduleTime: Date,
  distributionWindowSeconds: number
): Date {
  const distributionWindowMs = distributionWindowSeconds * 1000;

  // Generate a random offset within the distribution window
  // Use a hash of the schedule time to ensure consistent distribution
  // for the same schedule time across multiple calls
  const timeString = exactScheduleTime.toISOString();
  let hash = 0;
  for (let i = 0; i < timeString.length; i++) {
    const char = timeString.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Convert hash to a value between 0 and 1
  const normalized = Math.abs(hash) / 2147483648; // 2^31

  // Calculate offset (0 to distributionWindowMs)
  const offsetMs = Math.floor(normalized * distributionWindowMs);

  // Return the distributed execution time (before the exact schedule time)
  return new Date(exactScheduleTime.getTime() - offsetMs);
}

/**
 * Calculates a distributed execution time for a scheduled task.
 * Tasks are distributed across a time window before the exact schedule time
 * to prevent thundering herd issues while maintaining schedule accuracy.
 */
export function calculateDistributedExecutionTime(
  exactScheduleTime: Date,
  distributionWindowSeconds: number = 30,
  instanceId?: string
): Date {
  // Create seed by combining ISO timestamp with optional instanceId
  // This ensures different instances get different distributions even with same schedule time
  const timeSeed = exactScheduleTime.toISOString();
  const seed = instanceId ? `${timeSeed}:${instanceId}` : timeSeed;

  // Use a better hash function (FNV-1a variant) for more uniform distribution
  let hash = 2166136261; // FNV offset basis (32-bit)

  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash *= 16777619; // FNV prime (32-bit)
    // Keep it as 32-bit unsigned integer
    hash = hash >>> 0;
  }

  // Convert hash to a value between 0 and 1 using better normalization
  // Use the full 32-bit range for better distribution
  const normalized = hash / 0xffffffff;

  // Calculate offset in milliseconds (0 to distributionWindowSeconds * 1000)
  const offsetMs = Math.floor(normalized * distributionWindowSeconds * 1000);

  // Return time that's offsetMs before the exact schedule time
  return new Date(exactScheduleTime.getTime() - offsetMs);
}

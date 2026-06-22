/**
 * Shared colors for the task/agent activity charts. Previously each task
 * landing page (agent / standard / scheduled) defined its own identical
 * `STATUS_COLOR` table.
 *
 * Keys are the grouped chart series — run-status groups (see
 * `RUN_STATUS_GROUPS` in activitySeries.server.ts) plus the agent session
 * statuses.
 */
export const STATUS_COLOR: Record<string, string> = {
  // Run-status groups
  COMPLETED: "#28BF5C",
  RUNNING: "#3B82F6",
  FAILED: "#E11D48",
  CANCELED: "#878C99",
  // Agent session statuses
  ACTIVE: "#3B82F6",
  CLOSED: "#28BF5C",
  EXPIRED: "#878C99",
};

/** Fallback for any status not in the table. */
export const STATUS_COLOR_FALLBACK = "#9CA3AF";

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? STATUS_COLOR_FALLBACK;
}

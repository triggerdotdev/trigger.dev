/** Shared status → color map for the task/agent activity charts. */
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

export const STATUS_COLOR_FALLBACK = "#9CA3AF";

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? STATUS_COLOR_FALLBACK;
}

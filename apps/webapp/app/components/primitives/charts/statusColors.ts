/** Shared status → color map for the task/agent activity charts.
 * Values are CSS variables so they follow the theme; CSS contexts only. */
export const STATUS_COLOR: Record<string, string> = {
  // Run-status groups
  COMPLETED: "var(--color-success)",
  RUNNING: "var(--color-pending)",
  FAILED: "var(--color-error)",
  CANCELED: "var(--color-text-dimmed)",
  // Agent session statuses
  ACTIVE: "var(--color-pending)",
  CLOSED: "var(--color-success)",
  EXPIRED: "var(--color-text-dimmed)",
};

export const STATUS_COLOR_FALLBACK = "var(--color-text-dimmed)";

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? STATUS_COLOR_FALLBACK;
}

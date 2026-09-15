/** Shared status → color map for the task/agent activity charts.
 * Values are CSS variables so they follow the theme; CSS contexts only. */
const STATUS_COLOR: Record<string, string> = {
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

const STATUS_COLOR_FALLBACK = "var(--color-text-dimmed)";

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? STATUS_COLOR_FALLBACK;
}

const STATUS_ORDER = Object.keys(STATUS_COLOR);

/** Position in the canonical status order, or -1 for a value that isn't a known status. */
export function statusOrderIndex(status: string): number {
  return STATUS_ORDER.indexOf(status);
}

/** The mapped colour, or undefined for a value that isn't a known status. */
export function knownStatusColor(status: string): string | undefined {
  return STATUS_COLOR[status];
}

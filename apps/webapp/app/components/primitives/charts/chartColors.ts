import type { ChartConfig } from "./Chart";

const THEME_COLORS = new Set([
  "agents",
  "tasks",
  "success",
  "pending",
  "warning",
  "error",
  "text-dimmed",
  "queues-chart",
  "queues-chart-ref",
  "run-pending",
  "run-delayed",
  "run-pending-version",
  "run-waiting-for-deploy",
  "run-executing",
  "run-retrying-after-failure",
  "run-dequeued",
  "run-waiting-to-resume",
  "run-paused",
  "run-canceled",
  "run-expired",
  "run-interrupted",
  "run-completed-successfully",
  "run-completed-with-errors",
  "run-system-failure",
  "run-crashed",
  "run-timed-out",
]);

// Chart palettes and the color picker emit hex; theme references must name known color tokens.
export function safeChartColor(color: unknown): string | undefined {
  if (typeof color !== "string" || color !== color.trim()) return undefined;
  if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) return color;
  const token = /^var\(--color-([a-z-]+)\)$/.exec(color)?.[1];
  return token && THEME_COLORS.has(token) ? color : undefined;
}

export function safeChartConfig(config: ChartConfig): ChartConfig {
  return Object.fromEntries(
    Object.entries(config).map(([key, item]) => [
      key,
      item.theme
        ? {
            ...item,
            color: undefined,
            theme: {
              light: safeChartColor(item.theme.light) ?? "var(--color-text-dimmed)",
              dark: safeChartColor(item.theme.dark) ?? "var(--color-text-dimmed)",
            },
          }
        : { ...item, color: safeChartColor(item.color) ?? "var(--color-text-dimmed)" },
    ])
  );
}

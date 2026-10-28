export type UsageDay = { date: string; total: number };

export type ProjectUsageDay = {
  date: string;
  projects: { projectId: string; computeMs: number; runs: number }[];
};

export type ProjectMetric = "computeMs" | "runs";

export type UsageChartRow = { date: string } & Record<string, number | string>;

export const COST_SERIES_KEY = "cost";

export function costDaySeries(days: UsageDay[], minorUnitsPerUnit: number): UsageChartRow[] {
  return days.map((day) => ({ date: day.date, [COST_SERIES_KEY]: day.total / minorUnitsPerUnit }));
}

export function projectDaySeries(
  days: ProjectUsageDay[],
  projectIds: string[],
  metric: ProjectMetric
): UsageChartRow[] {
  return days.map((day) => {
    const row: UsageChartRow = { date: day.date };
    for (const projectId of projectIds) {
      row[projectId] = 0;
    }
    for (const entry of day.projects) {
      if (!projectIds.includes(entry.projectId)) continue;
      row[entry.projectId] = Number(row[entry.projectId]) + entry[metric];
    }
    return row;
  });
}

export function projectTotals(
  days: ProjectUsageDay[]
): Map<string, { computeMs: number; runs: number }> {
  const totals = new Map<string, { computeMs: number; runs: number }>();
  for (const day of days) {
    for (const entry of day.projects) {
      const current = totals.get(entry.projectId) ?? { computeMs: 0, runs: 0 };
      totals.set(entry.projectId, {
        computeMs: current.computeMs + entry.computeMs,
        runs: current.runs + entry.runs,
      });
    }
  }
  return totals;
}

export function fillMonthDays<T extends { date: string }>(
  days: T[],
  dates: string[],
  empty: (date: string) => T
): T[] {
  const byDate = new Map(days.map((day) => [day.date.slice(0, 10), day]));
  return dates.map((date) => byDate.get(date) ?? empty(date));
}

export type UsageCredits = {
  isCurrentMonth: boolean;
  creditsForUsage?: number;
  credits?: unknown[];
};

// Metronome's credit for usage in the month; the plan's allowance only stands in for the current month without it.
export function includedUsageDollars(
  usage: UsageCredits,
  minorUnitsPerUnit: number,
  planAllowanceDollars: number | undefined
): number | undefined {
  if (usage.credits?.length) return (usage.creditsForUsage ?? 0) / minorUnitsPerUnit;
  return usage.isCurrentMonth ? planAllowanceDollars : undefined;
}

export type UsageBarScale = { used: number; included?: number; limit?: number };

const USAGE_BAR_HEADROOM = 1.08;

export function usageBarScale(
  used: number,
  included: number | undefined,
  limit: number | undefined
): UsageBarScale {
  const shownIncluded = included && included > 0 ? included : undefined;
  const top = Math.max(used, shownIncluded ?? 0, limit ?? 0) * USAGE_BAR_HEADROOM;
  const percent = (value: number) => (top > 0 ? Math.min(100, (value / top) * 100) : 0);

  return {
    used: percent(used),
    included: shownIncluded === undefined ? undefined : percent(shownIncluded),
    limit: limit === undefined ? undefined : percent(limit),
  };
}

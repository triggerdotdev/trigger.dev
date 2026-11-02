const USAGE_MONTH_COUNT = 6;

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const dayWithYearFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function toUsageMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStart(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1));
}

export function usageMonths(now: Date, count = USAGE_MONTH_COUNT): string[] {
  return Array.from({ length: count }, (_, index) =>
    toUsageMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1)))
  );
}

export function resolveUsageMonth(requested: string | null | undefined, months: string[]): string {
  if (requested && months.includes(requested)) return requested;
  return months[0];
}

export function adjacentUsageMonths(
  month: string,
  months: string[]
): { previous?: string; next?: string } {
  const index = months.indexOf(month);
  if (index < 0) return {};
  return { previous: months[index + 1], next: months[index - 1] };
}

export function formatUsageMonth(month: string): string {
  return monthFormatter.format(monthStart(month));
}

// endsAt is exclusive, so the last day shown is the one before it.
export function formatCreditPeriod(startsAt: string, endsAt: string | null): string {
  const start = new Date(startsAt);
  if (!endsAt) return `From ${dayWithYearFormatter.format(start)}`;

  const lastDay = new Date(Date.parse(endsAt) - 1);
  const format =
    start.getUTCFullYear() === lastDay.getUTCFullYear() ? dayFormatter : dayWithYearFormatter;
  return `${format.format(start)} – ${format.format(lastDay)}`;
}

export function daysInUsageMonth(month: string): string[] {
  const start = monthStart(month);
  const days = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) =>
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), index + 1))
      .toISOString()
      .slice(0, 10)
  );
}

export function formatUsageDay(date: string): string {
  return dayWithYearFormatter.format(new Date(`${date.slice(0, 10)}T00:00:00Z`));
}

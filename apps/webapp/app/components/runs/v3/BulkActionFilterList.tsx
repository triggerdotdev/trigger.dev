import { BulkActionFilterChips } from "~/components/BulkActionFilterSummary";
import { useUserTimeZone } from "~/components/primitives/DateTime";
import { useLocales } from "~/components/primitives/LocaleProvider";
import * as Property from "~/components/primitives/PropertyTable";
import { TextLink } from "~/components/primitives/TextLink";
import { type TaskRunListSearchFilters } from "./RunFilters";
import { dateFromString, timeFilterRenderValues } from "./SharedFilters";

/** "Nov 10, 1:37 PM", with the year only when it isn't this year. */
function shortDate(date: Date, timeZone: string, locales: string[], withDate = true) {
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locales, {
    year: withDate && !sameYear ? "numeric" : undefined,
    month: withDate ? "short" : undefined,
    day: withDate ? "numeric" : undefined,
    hour: "numeric",
    minute: "numeric",
    hour12: true,
    timeZone,
  }).format(date);
}

/** The Created chip's value, shorter than the runs list's so it fits the rail. */
function useTimeValue(filters: TaskRunListSearchFilters): string | undefined {
  const timeZone = useUserTimeZone();
  const locales = useLocales();
  const from = filters.from ? dateFromString(`${filters.from}`) : undefined;
  const to = filters.to ? dateFromString(`${filters.to}`) : undefined;
  const hasRunIds = Array.isArray(filters.runId) ? filters.runId.length > 0 : !!filters.runId;
  // A run ID search without an explicit time applies no period.
  if (hasRunIds && !filters.period && !from && !to) return undefined;

  const { valueLabel, rangeType } = timeFilterRenderValues({ from, to, period: filters.period });
  if (rangeType === "range") {
    const sameDay =
      shortDate(from!, timeZone, locales).split(",")[0] ===
      shortDate(to!, timeZone, locales).split(",")[0];
    return `${shortDate(from!, timeZone, locales)} → ${shortDate(to!, timeZone, locales, !sameDay)}`;
  }
  if (rangeType === "from") return shortDate(from!, timeZone, locales);
  if (rangeType === "to") return shortDate(to!, timeZone, locales);
  return `Last ${valueLabel}`;
}

/**
 * The filters a filter-mode bulk action ran on, for the Selection group of its rail: the runs
 * list's own filter chips, read-only, with a link to the runs list.
 */
export function BulkActionFilterList({
  filters,
  runsListPath,
}: {
  filters: TaskRunListSearchFilters;
  /** The runs list with these filters applied. */
  runsListPath: string;
}) {
  const timeValue = useTimeValue(filters);
  return (
    <Property.Item className="min-w-0">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <Property.Label>Filters</Property.Label>
        <TextLink to={runsListPath} className="text-xs">
          Open in runs list
        </TextLink>
      </div>
      <BulkActionFilterChips
        filters={filters}
        chipVariant="secondary/small"
        timeValue={timeValue}
      />
    </Property.Item>
  );
}

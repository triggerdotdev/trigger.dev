import { Link } from "@remix-run/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header3 } from "~/components/primitives/Headers";
import { useLocales } from "~/components/primitives/LocaleProvider";
import * as Property from "~/components/primitives/PropertyTable";
import { useDimensions } from "~/hooks/useDimensions";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { formatNumber } from "~/utils/numberFormatter";
import { v3EnvironmentPath } from "~/utils/pathBuilder";
import {
  type DayDeployment,
  type LoadDay,
  DeployGrid,
  DeployGridLegend,
} from "./DeployActivityGrid";
import {
  type ActivityDay,
  GRID_WEEKS,
  formatDayRange,
  summarizeActivity,
} from "./deployActivityDays";

/* The deployment activity grid above the deployments list, shown with the toolbar's Activity
 * switch. `DeployActivityBand` takes its data as props (the storybook passes made-up data);
 * `DeploymentsActivityBand` at the end reads the real data and the URL. */

/** What the activity resource route returns for the grid. */
type ActivityData = { timeZone: string; today: string; days: ActivityDay[] };

function Fact({
  label,
  children,
  detail,
  onHover,
}: {
  label: string;
  children: ReactNode;
  detail?: ReactNode;
  /** Called with true while the pointer is over the figure. */
  onHover?: (hovering: boolean) => void;
}) {
  return (
    <div onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <Property.Item>
        <Property.Label>{label}</Property.Label>
        <Property.Value className="flex items-baseline gap-1.5 tabular-nums">
          {children}
          {detail ? <span className="text-xs">{detail}</span> : null}
        </Property.Value>
      </Property.Item>
    </div>
  );
}

/** Weekday names beside a grid whose weeks are columns, with the gap after them. */
const WEEKDAY_LABELS_WIDTH = 30;

/**
 * As many week columns as the element has room for, newest kept, up to a year. Undefined until
 * the element has been measured.
 */
function useFittedWeeks(cell: number, gap: number, reserved = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useDimensions(ref)?.width;
  const weeks =
    width === undefined
      ? undefined
      : Math.max(
          8,
          Math.min(
            GRID_WEEKS,
            Math.floor((width - reserved - WEEKDAY_LABELS_WIDTH + gap) / (cell + gap))
          )
        );
  return [ref, weeks] as const;
}

/** "the last 12 months" when the whole year fits, otherwise the weeks that do. */
function rangeLabel(weeks: number) {
  return weeks >= GRID_WEEKS ? "the last 12 months" : `the last ${weeks} weeks`;
}

function deployCount(count: number) {
  return `${formatNumber(count)} deploy${count === 1 ? "" : "s"}`;
}

/**
 * A year of this environment's deploys above the list. The heading carries the total the way
 * GitHub's does, the figures on the right answer how regularly it ships, and a click on a day
 * filters the list under it to that day.
 */
export function DeployActivityBand({
  today,
  days,
  loadDay,
  selectedDay,
  dayHref,
  failedHref,
}: {
  today: string;
  days: ActivityDay[];
  loadDay?: LoadDay;
  selectedDay?: string;
  dayHref?: (day: string) => string;
  /** The list filtered to failed deploys. */
  failedHref?: string;
}) {
  const locales = useLocales();
  const cell = 11;
  const gap = 3;
  // The figures keep their place beside the grid; the grid gives up its oldest weeks first.
  const [ref, weeks] = useFittedWeeks(cell, gap, 24 + 40 + 200);
  const summary = useMemo(
    () => summarizeActivity(today, days, weeks ?? GRID_WEEKS),
    [today, days, weeks]
  );
  const [showGap, setShowGap] = useState(false);

  return (
    <section
      ref={ref}
      className="flex min-h-[10.25rem] flex-none items-start gap-x-10 border-t border-grid-bright px-3 pb-3 pt-2.5"
    >
      {weeks ? (
        <>
          <div className="flex flex-none flex-col gap-2">
            <div className="flex min-h-6 items-center justify-between gap-6">
              <Header3>
                {summary.total === 0
                  ? `No deploys in ${rangeLabel(weeks)}`
                  : `${deployCount(summary.total)} in ${rangeLabel(weeks)}`}
              </Header3>
              <DeployGridLegend />
            </div>
            <DeployGrid
              label={`Deploys per day, ${rangeLabel(weeks)}`}
              today={today}
              days={days}
              cell={cell}
              gap={gap}
              weeks={weeks}
              loadDay={loadDay}
              selectedDay={selectedDay}
              highlighted={showGap ? summary.longestGap : undefined}
              dayHref={
                dayHref
                  ? (entry) =>
                      entry.total > 0 || entry.day === selectedDay ? dayHref(entry.day) : undefined
                  : undefined
              }
            />
          </div>
          {summary.total > 0 ? (
            <Property.Table className="flex-none gap-y-2.5">
              <Fact label="Weeks with a deploy" detail={`of ${formatNumber(summary.weeks)}`}>
                {formatNumber(summary.activeWeeks)}
              </Fact>
              {summary.longestGap ? (
                <Fact
                  label="Longest gap"
                  detail={formatDayRange(summary.longestGap.from, summary.longestGap.to, locales)}
                  onHover={setShowGap}
                >
                  {formatNumber(summary.longestGap.days)} day
                  {summary.longestGap.days === 1 ? "" : "s"}
                </Fact>
              ) : null}
              <Fact label="Failed" detail={`of ${formatNumber(summary.total)}`}>
                {failedHref && summary.failed > 0 ? (
                  <Link to={failedHref} className="text-text-link hover:text-text-link-hover">
                    {formatNumber(summary.failed)}
                  </Link>
                ) : (
                  formatNumber(summary.failed)
                )}
              </Fact>
            </Property.Table>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** The band's frame while its data is on the way, so the table under it doesn't jump. */
function DeployActivityBandLoading() {
  return (
    <section
      className="flex min-h-[10.25rem] flex-none border-t border-grid-bright px-3 pb-3 pt-2.5"
      aria-busy="true"
      aria-label="Loading deploy activity"
    >
      <div className="mt-8 h-[6.5rem] w-[46rem] rounded-sm bg-background-raised/50 motion-safe:animate-pulse" />
    </section>
  );
}

/**
 * Reads the grid's data from its resource route once the grid is on screen: a plain fetch, not
 * the page loader or a fetcher, because the deployments list polls and would reload it each time.
 * Nothing is asked for while the grid is hidden, since this only runs when the band is mounted.
 */
function useDeploymentActivity(
  /** The viewer's saved time zone: the days are theirs, so a change reads the counts again. */
  timeZone: string
) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const resource = `/resources${v3EnvironmentPath(organization, project, environment)}/deployments/activity`;
  const [loaded, setLoaded] = useState<{ resource: string; data: ActivityData | null }>();

  useEffect(() => {
    let current = true;
    fetch(resource)
      .then((response) => (response.ok ? (response.json() as Promise<ActivityData>) : null))
      .then((data) => {
        if (current) setLoaded({ resource, data });
      })
      .catch(() => {
        if (current) setLoaded({ resource, data: null });
      });
    return () => {
      current = false;
    };
  }, [resource, timeZone]);

  const loadDay = useCallback<LoadDay>(
    (day) =>
      fetch(`${resource}?day=${day}`)
        .then((response) =>
          response.ok ? (response.json() as Promise<{ deployments: DayDeployment[] }>) : null
        )
        .then((data) => data?.deployments ?? []),
    [resource]
  );

  return {
    /** Undefined while loading, null when it couldn't be read. */
    data: loaded?.resource === resource ? loaded.data : undefined,
    loadDay,
  };
}

/** The grid above the deployments list, on this environment's real data. */
export function DeploymentsActivityBand({
  timeZone,
}: {
  /** The time zone the list's own day filter uses. */
  timeZone: string;
}) {
  const { data, loadDay } = useDeploymentActivity(timeZone);
  const { search, pathname } = useOptimisticLocation();
  const selectedDay = new URLSearchParams(search).get("day") ?? undefined;

  if (data === undefined) return <DeployActivityBandLoading />;
  if (!data) return null;

  /** The list's URL with the day filter set, or cleared when that day is already the filter. */
  const dayHref = (day: string) => {
    const params = new URLSearchParams(search);
    params.delete("page");
    if (day === selectedDay) params.delete("day");
    else params.set("day", day);
    return `${pathname}?${params.toString()}`;
  };

  const failed = new URLSearchParams(search);
  failed.delete("page");
  failed.delete("day");
  failed.delete("statuses");
  failed.append("statuses", "FAILED");
  failed.append("statuses", "TIMED_OUT");

  return (
    <DeployActivityBand
      // A new time zone is a new set of days: drop the hover cards the grid has kept.
      key={data.timeZone}
      today={data.today}
      days={data.days}
      loadDay={loadDay}
      selectedDay={selectedDay}
      dayHref={dayHref}
      failedHref={`${pathname}?${failed.toString()}`}
    />
  );
}

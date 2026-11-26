import { ChevronLeftIcon, ChevronRightIcon, SunIcon } from "@heroicons/react/20/solid";
import { Link, useLocation, useNavigate } from "@remix-run/react";
import {
  Fragment,
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from "react";
import { LinkButton } from "~/components/primitives/Buttons";
import { useUserTimeZone } from "~/components/primitives/DateTime";
import { DetailTabEmpty } from "~/components/primitives/detail/DetailSections";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import type {
  ScheduleCalendar,
  ScheduleCalendarView,
  ScheduleClockChange,
  ScheduleDayRun,
} from "~/v3/scheduleUpcoming.server";
import {
  clockChangeEffect,
  clockChangeLabel,
  dateInZone,
  formatClock,
  formatInZone,
  formatMinutes,
  formatOffset,
  formatTime,
  minutesIntoDay,
} from "./scheduleTime";
import { type ScheduleDetail, shortUntil } from "./ScheduleViews";

/*
 * The Upcoming tab: a calendar beside a day. The calendar takes most of the column: six weeks
 * from this week, then a month at a time (`?month=`), each day with when its runs start and end,
 * how many there are, and a midnight-to-midnight bar of them (window bands behind the ticks). A
 * schedule that runs on only a few days, like a monthly or quarterly one, opens on a year of
 * small months instead (`?view=`). Days with a daylight saving change carry a sun. Picking a day
 * (`?day=`) lists its runs beside the calendar as an edge-to-edge table, the change inline where
 * it happens. Like a calendar app's month view beside a booking page's time slots.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_MS = 86_400_000;
const DAY_SECONDS = 86_400;
/** The calendar goes this many months ahead (the loader clamps to the same). */
const HORIZON_MONTHS = 60;
/** A day with this many runs or fewer lists each one; a busier day shows its first and last. */
const LISTED_RUNS = 3;
/** A day whose runs are never further apart than this runs around the clock: no times to show. */
const AROUND_THE_CLOCK_GAP = 2 * 3600;

type CalendarDay = ScheduleCalendar["days"][number];
/** One array for every day without runs, so such a day's cell gets the same props each render. */
const NO_RUNS: ScheduleDayRun[] = [];

/** How the Upcoming tab moves between days, months and views when the page moves it itself. */
export type ScheduleCalendarNav = {
  /** The page's search params, with the calendar the tab shows or is loading. */
  search: string;
  /** Goes to a link made from them ("?day=2027-03-28"). */
  go: (to: string) => void;
};

/**
 * With `nav`, the page changes the calendar in place: a day click repaints the tab alone, and no
 * navigation reloads the layouts around it. Without one (a story) the links navigate as usual.
 */
export function useCalendarNav(nav: ScheduleCalendarNav | undefined) {
  const location = useLocation();
  const navigate = useNavigate();
  return {
    pathname: location.pathname,
    search: nav?.search ?? location.search,
    go: nav?.go ?? ((to: string) => navigate(to, { replace: true, preventScrollReset: true })),
    /** For the tab's root: a plain click on one of its links goes there in place. */
    onClickCapture: nav
      ? (event: MouseEvent<HTMLElement>) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
          if (event.altKey || !(event.target instanceof Element)) return;
          const link = event.target.closest("a");
          if (!link || link.target || link.origin !== window.location.origin) return;
          if (link.pathname !== location.pathname) return;
          event.preventDefault();
          nav.go(link.search);
        }
      : undefined,
  };
}

export function ScheduleUpcomingCalendar({
  schedule,
  now,
  calendar,
  loading = false,
  enableAction,
  nav: pageNav,
}: {
  schedule: ScheduleDetail;
  /** The page's clock, in epoch ms. */
  now: number;
  calendar: ScheduleCalendar | undefined;
  /** A click already asks for another day or month than `calendar` has. */
  loading?: boolean;
  enableAction?: ReactNode;
  nav?: ScheduleCalendarNav;
}) {
  const timezone = schedule.timezone;
  const nav = useCalendarNav(pageNav);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusDay = useRef<string | undefined>(undefined);
  const selectedDay = calendar?.selected?.day;

  // After an arrow key moved the picked day, focus follows it once the day has loaded.
  useEffect(() => {
    if (!selectedDay || focusDay.current !== selectedDay) return;
    focusDay.current = undefined;
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${selectedDay}"]`)?.focus();
  }, [selectedDay]);

  if (!calendar) {
    return <DetailTabEmpty title="No upcoming runs" description="This cron has no future times." />;
  }

  const today = dateInZone(new Date(now), timezone);
  const currentMonth = today.slice(0, 7);
  const nowSeconds = minutesIntoDay(new Date(now), timezone) * 60;
  const firstDate = calendar.days[0].date;
  const lastDate = calendar.days[calendar.days.length - 1].date;

  // A click shows where it's going before its calendar has loaded.
  const asked = new URLSearchParams(nav.search);
  const pending = loading ? asked : undefined;
  const selectedDate = pending?.get("day") ?? selectedDay;

  const href = (changes: Record<string, string | undefined>) => {
    const params = new URLSearchParams(nav.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) params.delete(key);
      else params.set(key, value);
    }
    const search = params.toString();
    return search ? `?${search}` : nav.pathname;
  };
  const monthParam = (month: string) => (month <= currentMonth ? undefined : month);
  /** Picks a day, paging the calendar to it when it isn't one of the days drawn. */
  const dayHref = (date: string) =>
    date >= firstDate && date <= lastDate
      ? href({ day: date })
      : href({ day: date, month: monthParam(date.slice(0, 7)) });

  const shownMonth = calendar.month ?? currentMonth;
  const step = calendar.view === "year" ? 12 : 1;
  const previousMonth =
    shownMonth > currentMonth ? maxString(shiftMonth(shownMonth, -step), currentMonth) : undefined;
  const nextMonth =
    shiftMonth(shownMonth, step) <= shiftMonth(currentMonth, HORIZON_MONTHS)
      ? shiftMonth(shownMonth, step)
      : undefined;
  const unit = calendar.view === "year" ? "year" : "month";
  const atDefault = !asked.has("month") && !asked.has("day");

  const changeDays = new Map(
    calendar.clockChanges.map(
      (change) => [dateInZone(new Date(change.at), timezone), change] as const
    )
  );
  const runsOf = (day: CalendarDay): ScheduleDayRun[] =>
    day.pattern === null ? NO_RUNS : (calendar.patterns[day.pattern] ?? NO_RUNS);
  /** The day's runs still to come: none on a past day, the rest of today's. */
  const upcomingOf = (day: CalendarDay) =>
    day.date < today
      ? NO_RUNS
      : day.date === today
        ? runsOf(day).filter((run) => run[1] > nowSeconds)
        : runsOf(day);

  const usualStarts = mostCommonStarts(
    calendar.days.filter((day) => day.date > today),
    calendar.patterns
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!schedule.active || event.metaKey || event.ctrlKey || event.altKey) return;
    const days =
      event.key === "ArrowLeft"
        ? -1
        : event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowUp"
            ? -7
            : event.key === "ArrowDown"
              ? 7
              : 0;
    if (!days) return;
    event.preventDefault();
    const target = shiftDate(selectedDate ?? today, days);
    if (target < today || target.slice(0, 7) > shiftMonth(currentMonth, HORIZON_MONTHS)) return;
    focusDay.current = target;
    nav.go(dayHref(target));
  };

  const laterChanges = calendar.clockChanges
    .filter((change) => dateInZone(new Date(change.at), timezone) >= maxString(firstDate, today))
    .slice(0, 2);

  return (
    <div className="@container/upcoming h-full" onClickCapture={nav.onClickCapture}>
      <div className="grid h-full grid-cols-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control @[44rem]/upcoming:grid-cols-[minmax(0,1.6fr)_minmax(17.5rem,1fr)] @[44rem]/upcoming:overflow-hidden">
        <div className="@container/calendar flex min-w-0 flex-col border-b border-grid-bright @[44rem]/upcoming:overflow-hidden @[44rem]/upcoming:border-b-0 @[44rem]/upcoming:border-r">
          <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-grid-bright py-1.5 pl-3 pr-2">
            <span className="truncate text-sm text-text-bright">
              {calendarTitle(calendar, firstDate, lastDate)}
            </span>
            <span className="flex flex-none items-center gap-2">
              <SegmentedControl
                name="upcoming-view"
                value={calendar.view}
                variant="secondary/small"
                onChange={(view) => {
                  if (view !== calendar.view) nav.go(href({ view }));
                }}
                options={[
                  { label: "Month", value: "month" satisfies ScheduleCalendarView },
                  { label: "Year", value: "year" satisfies ScheduleCalendarView },
                ]}
              />
              <span className="flex items-center gap-0.5">
                <LinkButton
                  to={
                    previousMonth ? href({ month: monthParam(previousMonth), day: undefined }) : "#"
                  }
                  variant="minimal/small"
                  LeadingIcon={ChevronLeftIcon}
                  disabled={!previousMonth}
                  replace
                  tooltip={`Previous ${unit}`}
                />
                {/* Never disabled: on the current view it changes nothing, as in a calendar app. */}
                <LinkButton
                  to={href({ month: undefined, day: undefined })}
                  variant="secondary/small"
                  replace
                  tooltip={atDefault ? undefined : "Back to the next run"}
                >
                  Today
                </LinkButton>
                <LinkButton
                  to={nextMonth ? href({ month: nextMonth, day: undefined }) : "#"}
                  variant="minimal/small"
                  LeadingIcon={ChevronRightIcon}
                  disabled={!nextMonth}
                  replace
                  tooltip={`Next ${unit}`}
                />
              </span>
            </span>
          </div>
          <div
            // The header and the footer stay put; a short window scrolls the days between them.
            className={cn(
              "flex flex-1 flex-col transition-opacity @[44rem]/upcoming:min-h-0 @[44rem]/upcoming:overflow-y-auto @[44rem]/upcoming:scrollbar-thin @[44rem]/upcoming:scrollbar-track-transparent @[44rem]/upcoming:scrollbar-thumb-surface-control",
              pending && !pending.has("day") && "opacity-60"
            )}
          >
            {calendar.view === "month" ? (
              <MonthGrid
                gridRef={gridRef}
                onKeyDown={onKeyDown}
                calendar={calendar}
                today={today}
                nowSeconds={nowSeconds}
                selected={selectedDate}
                changeDays={changeDays}
                runsOf={runsOf}
                upcomingOf={upcomingOf}
                usualStarts={usualStarts}
                dayHref={dayHref}
                active={schedule.active}
                timezone={timezone}
              />
            ) : (
              <YearGrid
                gridRef={gridRef}
                onKeyDown={onKeyDown}
                calendar={calendar}
                today={today}
                selected={selectedDate}
                changeDays={changeDays}
                upcomingOf={upcomingOf}
                dayHref={dayHref}
                monthHref={(month) =>
                  href({ view: "month", month: monthParam(month), day: undefined })
                }
                active={schedule.active}
              />
            )}
          </div>
          <UpcomingFooter
            timezone={timezone}
            changes={laterChanges}
            today={today}
            selected={selectedDate}
            dayHref={dayHref}
          />
        </div>
        <div className="flex min-w-0 flex-col @[44rem]/upcoming:overflow-hidden">
          {!schedule.active ? (
            <DetailTabEmpty
              title="Disabled"
              description="The faded days are when it would run. Enable it to pick up from the next cron time."
              action={enableAction}
            />
          ) : calendar.selected ? (
            <SelectedDay
              schedule={schedule}
              selected={calendar.selected}
              change={changeDays.get(calendar.selected.day)}
              dayHref={dayHref}
              now={now}
              loading={pending !== undefined && pending.get("day") !== calendar.selected.day}
            />
          ) : (
            <DetailTabEmpty
              title="No runs here"
              description={`It doesn't run in ${calendarSpan(calendar, firstDate, lastDate)}.`}
              action={
                <LinkButton
                  to={href({ month: undefined, day: undefined })}
                  variant="secondary/small"
                  replace
                >
                  Go to the next run
                </LinkButton>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Under the calendar: the timezone its times are in, and the next daylight saving changes. */
export function UpcomingFooter({
  timezone,
  changes,
  today,
  selected,
  dayHref,
}: {
  timezone: string;
  /** The next changes, soonest first; the second shows only when there's room. */
  changes: ScheduleClockChange[];
  today: string;
  selected: string | undefined;
  dayHref: (date: string) => string;
}) {
  return (
    <div className="flex min-h-8 flex-none items-center justify-between gap-x-4 border-t border-grid-bright px-3 py-1.5 text-xs text-text-dimmed">
      <span className="flex-none">Times in {timezone}</span>
      <span className="flex min-w-0 items-center gap-3">
        {changes.map((change, index) => {
          const date = dateInZone(new Date(change.at), timezone);
          const direction = change.deltaMinutes > 0 ? "forward" : "back";
          return (
            <SimpleTooltip
              key={date}
              asChild
              disableHoverableContent
              button={
                <Link
                  to={dayHref(date)}
                  replace
                  preventScrollReset
                  className={cn(
                    "flex-none items-center gap-1 whitespace-nowrap tabular-nums transition hover:text-text-bright",
                    // The change after next only when there's room beside the timezone.
                    index === 0 ? "flex" : "hidden @[34rem]/calendar:flex",
                    date === selected && "text-text-bright"
                  )}
                >
                  <SunIcon className="size-3.5 flex-none text-warning" />
                  {formatDate(date, {
                    month: "short",
                    day: "numeric",
                    year: date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
                  })}
                  <span>{clockChangeDelta(change)}</span>
                </Link>
              }
              content={
                <span className="text-xs">
                  Clocks go {direction} {formatMinutes(Math.abs(change.deltaMinutes))} (
                  {clockChangeLabel(new Date(change.at), change.deltaMinutes, timezone)})
                </span>
              }
            />
          );
        })}
      </span>
    </div>
  );
}

/**
 * "Next 6 weeks" for the view that starts from this week, "March 2027" for a month's page,
 * "Next 12 months", "2028" or "Mar 2027 to Feb 2028" for a year of months.
 */
function calendarTitle(calendar: ScheduleCalendar, firstDate: string, lastDate: string) {
  if (!calendar.month) return calendar.view === "month" ? "Next 6 weeks" : "Next 12 months";
  if (calendar.view === "month") {
    return formatDate(`${calendar.month}-01`, { month: "long", year: "numeric" });
  }
  if (firstDate.slice(5) === "01-01" && lastDate.slice(5) === "12-31") return firstDate.slice(0, 4);
  return `${formatDate(firstDate, { month: "short", year: "numeric" })} to ${formatDate(lastDate, { month: "short", year: "numeric" })}`;
}

/** The title inside a sentence: "the next 6 weeks", "March 2027". */
function calendarSpan(calendar: ScheduleCalendar, firstDate: string, lastDate: string) {
  const title = calendarTitle(calendar, firstDate, lastDate);
  return calendar.month ? title : `the ${title.toLowerCase()}`;
}

/** When a day's runs start, as one string to compare days by. */
function startsOf(runs: ScheduleDayRun[] | undefined) {
  return (runs ?? []).map((run) => run[1]).join(",");
}

/** The start times most days have: a day with others (a clock change) is worth a second look. */
function mostCommonStarts(days: CalendarDay[], patterns: ScheduleDayRun[][]) {
  const counts = new Map<string, number>();
  let usual: string | undefined;
  for (const day of days) {
    if (day.pattern === null) continue;
    const starts = startsOf(patterns[day.pattern]);
    const count = (counts.get(starts) ?? 0) + 1;
    counts.set(starts, count);
    if (usual === undefined || count > (counts.get(usual) ?? 0)) usual = starts;
  }
  return usual;
}

/** No gap between runs longer than two hours, midnight to midnight and across it. */
function runsAroundTheClock(runs: ScheduleDayRun[]) {
  if (runs.length <= LISTED_RUNS) return false;
  let previous = runs[runs.length - 1][1] - DAY_SECONDS;
  for (const run of runs) {
    if (run[1] - previous > AROUND_THE_CLOCK_GAP) return false;
    previous = run[1];
  }
  return true;
}

/** The arrow keys move the picked day while the grid has focus. */
type GridKeys = {
  gridRef: RefObject<HTMLDivElement>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
};

function MonthGrid({
  gridRef,
  onKeyDown,
  calendar,
  today,
  nowSeconds,
  selected,
  changeDays,
  runsOf,
  upcomingOf,
  usualStarts,
  dayHref,
  active,
  timezone,
}: GridKeys & {
  calendar: ScheduleCalendar;
  today: string;
  nowSeconds: number;
  selected: string | undefined;
  changeDays: Map<string, ScheduleClockChange>;
  runsOf: (day: CalendarDay) => ScheduleDayRun[];
  upcomingOf: (day: CalendarDay) => ScheduleDayRun[];
  usualStarts: string | undefined;
  dayHref: (date: string) => string;
  active: boolean;
  timezone: string;
}) {
  // One cell takes the Tab key: the picked day, or the first day that can be picked.
  const tabStop = selected ?? calendar.days.find((day) => day.date >= today)?.date;
  const todayColumn = calendar.days.findIndex((day) => day.date === today) % 7;
  return (
    <>
      <div className="grid flex-none grid-cols-7 border-b border-grid-dimmed">
        {WEEKDAYS.map((weekday, index) => (
          <span
            key={weekday}
            className={cn(
              "px-1.5 py-1.5 text-xs @[32rem]/calendar:px-2",
              index === todayColumn ? "text-text-bright" : "text-text-dimmed"
            )}
          >
            {weekday}
          </span>
        ))}
      </div>
      <div
        ref={gridRef}
        onKeyDown={onKeyDown}
        role="grid"
        tabIndex={-1}
        aria-label="Days it runs"
        className="grid flex-1 auto-rows-[minmax(6rem,1fr)] grid-cols-7 outline-none"
      >
        {calendar.days.map((day, index) => (
          <DayCell
            key={day.date}
            date={day.date}
            runs={runsOf(day)}
            upcoming={upcomingOf(day)}
            nowSeconds={day.date === today ? nowSeconds : undefined}
            isPast={day.date < today}
            isToday={day.date === today}
            isSelected={day.date === selected}
            isTabStop={day.date === tabStop}
            // On a month's page the days either side of it step back.
            isOutside={calendar.month !== undefined && day.date.slice(0, 7) !== calendar.month}
            isUnusual={
              day.pattern !== null && startsOf(calendar.patterns[day.pattern]) !== usualStarts
            }
            isLastColumn={index % 7 === 6}
            isLastRow={index >= calendar.days.length - 7}
            change={changeDays.get(day.date)}
            href={dayHref(day.date)}
            active={active}
            timezone={timezone}
          />
        ))}
      </div>
    </>
  );
}

/*
 * A day. Colour says one thing each: the schedule's yellow is a run (the bar), the link colour is
 * the picked day, the light pill is today, and the sun is a clock change. Times stay quiet on an
 * ordinary day and come forward on today, the picked day and a day whose runs differ from the rest.
 * Memoized: picking a day changes two of the 42 cells, and each carries a tooltip.
 */
const DayCell = memo(function DayCell({
  date,
  runs,
  upcoming,
  nowSeconds,
  isPast,
  isToday,
  isSelected,
  isTabStop,
  isOutside,
  isUnusual,
  isLastColumn,
  isLastRow,
  change,
  href,
  active,
  timezone,
}: {
  date: string;
  /** Every run of the day, for the bar. */
  runs: ScheduleDayRun[];
  /** The runs still to come, for the times and the count. */
  upcoming: ScheduleDayRun[];
  nowSeconds: number | undefined;
  isPast: boolean;
  isToday: boolean;
  isSelected: boolean;
  isTabStop: boolean;
  isOutside: boolean;
  /** Its runs aren't the ones most days have. */
  isUnusual: boolean;
  isLastColumn: boolean;
  isLastRow: boolean;
  change: ScheduleClockChange | undefined;
  href: string;
  active: boolean;
  timezone: string;
}) {
  const dayNumber = Number(date.slice(8));
  const first = upcoming[0];
  const last = upcoming[upcoming.length - 1];
  // On the hour everywhere reads "9 AM"; otherwise every time keeps its minutes.
  const withMinutes = upcoming.some((run) => run[1] % 3600 >= 60);
  // Round the clock, the first and last time say nothing the bar doesn't.
  const showTimes = first !== undefined && !runsAroundTheClock(runs);
  const times = cn(
    "text-xs tabular-nums transition-colors",
    active && (isSelected || isToday || isUnusual || change)
      ? "text-text-bright"
      : "text-text-dimmed",
    active && "group-hover/day:text-text-bright"
  );
  const frame = cn(
    "group/day relative flex min-w-0 flex-col gap-1 border-grid-dimmed px-1.5 py-1.5 @[32rem]/calendar:px-2",
    !isLastColumn && "border-r",
    !isLastRow && "border-b"
  );
  const number = (
    <span
      className={cn(
        "text-xs tabular-nums leading-4",
        isToday
          ? "-mx-1 rounded-sm bg-text-bright px-1 font-medium text-background-dimmed"
          : isPast
            ? "text-text-faint"
            : upcoming.length > 0 && active
              ? "text-text-bright"
              : "text-text-dimmed"
      )}
    >
      {dayNumber === 1 && !isToday
        ? formatDate(date, { month: "short", day: "numeric" })
        : dayNumber}
    </span>
  );

  if (isPast) {
    return (
      <span role="gridcell" className={cn(frame, "bg-background-deep/40")}>
        <span className="flex">{number}</span>
      </span>
    );
  }

  const body = (
    <>
      <span className="flex items-center justify-between gap-1">
        {number}
        {change ? (
          <span className="flex items-center gap-0.5 text-xxs tabular-nums text-text-dimmed">
            <SunIcon className="size-3 flex-none text-warning" />
            {clockChangeDelta(change)}
          </span>
        ) : null}
      </span>
      {!showTimes ? null : upcoming.length <= LISTED_RUNS ? (
        // A few runs are each their own line; more are a span from the first to the last.
        <span className={cn(times, "flex min-w-0 flex-col")}>
          {upcoming.map((run) => (
            <CellTime key={run[0]} seconds={run[1]} minutes={withMinutes} />
          ))}
        </span>
      ) : (
        // The rule that joins them hangs in the cell's padding, so the times keep the full width.
        <span
          className={cn(
            times,
            "relative flex min-w-0 flex-col before:absolute before:inset-y-[3px] before:-left-[3px] before:w-px before:bg-border-bright @[32rem]/calendar:before:-left-1"
          )}
        >
          <CellTime seconds={first[1]} minutes={withMinutes} />
          <CellTime seconds={last[1]} minutes={withMinutes} />
        </span>
      )}
      {runs.length > 0 ? (
        <span className="mt-auto flex items-center gap-1.5">
          <DayBar runs={runs} active={active} nowSeconds={nowSeconds} />
          {upcoming.length > 1 ? (
            <span className="flex-none text-xxs tabular-nums leading-none text-text-dimmed">
              {upcoming.length.toLocaleString("en-US")}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  const label = formatDate(date, { weekday: "long", month: "short", day: "numeric" });
  const summary =
    upcoming.length === 0
      ? isToday && runs.length > 0
        ? "no runs left"
        : "no runs"
      : upcoming.length === 1
        ? `1 run${isToday ? " left" : ""}, ${formatSeconds(first[1], true)}`
        : `${upcoming.length.toLocaleString("en-US")} runs${isToday ? " left" : ""}, ${formatSeconds(first[1], true)} to ${formatSeconds(last[1], true)}`;
  const tooltip = (
    <span className="flex max-w-64 flex-col gap-0.5 text-xs">
      <span>
        {label}: {summary}
      </span>
      {change ? (
        <span className="text-text-dimmed">
          Clocks go {change.deltaMinutes > 0 ? "forward" : "back"}{" "}
          {formatMinutes(Math.abs(change.deltaMinutes))} (
          {clockChangeLabel(new Date(change.at), change.deltaMinutes, timezone)})
          {clockChangeEffect(change, timezone) ? `: ${clockChangeEffect(change, timezone)}` : ""}
        </span>
      ) : null}
    </span>
  );

  const look = cn(
    frame,
    isOutside && "[&>*]:opacity-50",
    isSelected && "bg-background-bright outline outline-1 -outline-offset-1 outline-text-link"
  );

  return (
    <SimpleTooltip
      asChild
      disableHoverableContent
      button={
        active ? (
          <Link
            to={href}
            replace
            preventScrollReset
            role="gridcell"
            aria-selected={isSelected}
            aria-current={isToday ? "date" : undefined}
            data-day={date}
            tabIndex={isTabStop ? 0 : -1}
            className={cn(
              look,
              // A square ring: the shared focus style rounds its corners, wrong inside a grid.
              "transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-text-link",
              !isSelected && "hover:bg-background-bright"
            )}
          >
            {body}
          </Link>
        ) : (
          <span role="gridcell" className={look}>
            {body}
          </span>
        )
      }
      content={tooltip}
    />
  );
});

/** "2:30 AM" with the AM set small, so a time fits a narrow day. */
function CellTime({ seconds, minutes }: { seconds: number; minutes: boolean }) {
  const [time, meridiem] = formatSeconds(seconds, minutes).split(/\s+/);
  return (
    <span className="flex items-baseline gap-0.5 whitespace-nowrap leading-4">
      {time}
      <span className="text-xxs opacity-70">{meridiem}</span>
    </span>
  );
}

/**
 * The day from midnight to midnight: a tick where each run starts, on a band from its cron time
 * to the end of its window when it has one. Lines at 6 AM, noon and 6 PM sit under the runs, so a
 * tick's place in the day can be read and a busy day stays one solid bar. Today's past part is
 * faded up to a line at now.
 */
function DayBar({
  runs,
  active,
  nowSeconds,
}: {
  runs: ScheduleDayRun[];
  active: boolean;
  nowSeconds: number | undefined;
}) {
  // A lone run still needs a tick wide enough to see; dense runs merge into one bar.
  const tick = Math.max(
    DAY_SECONDS / 40,
    Math.min(DAY_SECONDS / 24, DAY_SECONDS / runs.length / 2)
  );
  const hasBands = runs.some((run) => run[2] - run[0] > tick);
  return (
    <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-xs bg-grid-bright">
      <svg
        viewBox={`0 0 ${DAY_SECONDS} 8`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
        aria-hidden
      >
        <path
          d={[6, 12, 18].map((hour) => `M${hour * 3600} 0v8`).join("")}
          className="stroke-background-dimmed"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {hasBands ? (
          <path
            d={runs.map((run) => `M${run[0]} 0h${run[2] - run[0]}v8h-${run[2] - run[0]}z`).join("")}
            className={active ? "fill-schedules/35" : "fill-text-faint/35"}
          />
        ) : null}
        <path
          d={runs.map((run) => `M${run[1]} 0h${tick}v8h-${tick}z`).join("")}
          className={active ? "fill-schedules" : "fill-text-faint"}
        />
      </svg>
      {nowSeconds !== undefined ? (
        <span
          className="absolute inset-y-0 left-0 border-r border-text-bright bg-background-dimmed/70"
          style={{ width: `${(nowSeconds / DAY_SECONDS) * 100}%` }}
        />
      ) : null}
    </span>
  );
}

/** Twelve small months, the days it runs filled in; a month's name opens that month. */
function YearGrid({
  gridRef,
  onKeyDown,
  calendar,
  today,
  selected,
  changeDays,
  upcomingOf,
  dayHref,
  monthHref,
  active,
}: GridKeys & {
  calendar: ScheduleCalendar;
  today: string;
  selected: string | undefined;
  changeDays: Map<string, ScheduleClockChange>;
  upcomingOf: (day: CalendarDay) => ScheduleDayRun[];
  dayHref: (date: string) => string;
  monthHref: (month: string) => string;
  active: boolean;
}) {
  const months = new Map<string, CalendarDay[]>();
  for (const day of calendar.days) {
    const month = day.date.slice(0, 7);
    const days = months.get(month);
    if (days) days.push(day);
    else months.set(month, [day]);
  }
  const tabStop = selected ?? calendar.days.find((day) => day.date >= today)?.date;

  return (
    <div
      ref={gridRef}
      onKeyDown={onKeyDown}
      role="grid"
      tabIndex={-1}
      aria-label="Days it runs"
      className="grid flex-1 auto-rows-min grid-cols-2 gap-x-6 gap-y-3 p-3 outline-none @[27rem]/calendar:grid-cols-3 @[44rem]/calendar:grid-cols-4"
    >
      {[...months].map(([month, days], monthIndex) => {
        const lead = (new Date(`${month}-01T12:00:00Z`).getUTCDay() + 6) % 7;
        const monthRuns = days.flatMap((day) => upcomingOf(day));
        const runCount = monthRuns.length;
        return (
          <div key={month} className="flex min-w-0 flex-col gap-1">
            <span className="flex items-baseline justify-between gap-2 px-0.5">
              <Link
                to={monthHref(month)}
                replace
                preventScrollReset
                className={cn(
                  "truncate rounded-sm text-xs font-medium transition focus-custom hover:text-text-link",
                  runCount > 0 && active ? "text-text-bright" : "text-text-dimmed"
                )}
              >
                {formatDate(`${month}-01`, { month: "long" })}
                {/* The year where it starts and where it turns. */}
                {monthIndex === 0 || month.endsWith("-01") ? (
                  <span className="font-normal text-text-dimmed"> {month.slice(0, 4)}</span>
                ) : null}
              </Link>
              {runCount > 0 ? (
                <span className="flex-none text-xxs tabular-nums text-text-dimmed">
                  {/* A lone run's time says more than "1 run": its day is already filled in. */}
                  {runCount === 1
                    ? formatSeconds(monthRuns[0][1], monthRuns[0][1] % 3600 >= 60)
                    : `${runCount.toLocaleString("en-US")} runs`}
                </span>
              ) : null}
            </span>
            <div className="grid grid-cols-7 gap-px">
              {WEEKDAYS.map((weekday) => (
                <span
                  key={weekday}
                  aria-hidden
                  className="flex h-3.5 items-center justify-center text-xxs text-text-faint"
                >
                  {weekday[0]}
                </span>
              ))}
              {Array.from({ length: lead }, (_, index) => (
                <span key={`lead-${index}`} />
              ))}
              {days.map((day) => {
                const date = day.date;
                const upcoming = upcomingOf(day);
                const runs = upcoming.length > 0;
                const isPast = date < today;
                const change = changeDays.get(date);
                // Same marks as a month's days: yellow is a run, the light pill is today, the
                // link colour rings the picked day.
                const cell = cn(
                  "relative flex h-[1.125rem] items-center justify-center rounded-sm text-xxs tabular-nums",
                  isPast
                    ? "text-text-faint/60"
                    : runs
                      ? active
                        ? "bg-schedules font-medium text-background-dimmed"
                        : "bg-text-faint/40 text-text-bright"
                      : date === today
                        ? "bg-text-bright font-medium text-background-dimmed"
                        : "text-text-dimmed",
                  date === selected && "outline outline-1 outline-offset-1 outline-text-link"
                );
                const content = (
                  <>
                    {Number(date.slice(8))}
                    {change ? (
                      <span className="absolute -bottom-px left-1/2 h-0.5 w-2 -translate-x-1/2 rounded-full bg-warning" />
                    ) : null}
                  </>
                );
                if (isPast || !active) {
                  return (
                    <span key={date} role="gridcell" className={cell}>
                      {content}
                    </span>
                  );
                }
                const link = (
                  <Link
                    key={date}
                    to={dayHref(date)}
                    replace
                    preventScrollReset
                    role="gridcell"
                    aria-selected={date === selected}
                    data-day={date}
                    tabIndex={date === tabStop ? 0 : -1}
                    className={cn(
                      cell,
                      "transition focus-custom",
                      runs
                        ? "hover:brightness-110"
                        : date !== today && "hover:bg-background-hover hover:text-text-bright"
                    )}
                  >
                    {content}
                  </Link>
                );
                return runs || change ? (
                  <SimpleTooltip
                    key={date}
                    asChild
                    disableHoverableContent
                    button={link}
                    content={
                      <span className="text-xs">
                        {formatDate(date, { weekday: "short", month: "short", day: "numeric" })}
                        {runs
                          ? upcoming.length === 1
                            ? `: ${formatSeconds(upcoming[0][1], true)}`
                            : `: ${upcoming.length.toLocaleString("en-US")} runs, ${formatSeconds(upcoming[0][1], true)} to ${formatSeconds(upcoming[upcoming.length - 1][1], true)}`
                          : ""}
                        {change
                          ? `. Clocks go ${change.deltaMinutes > 0 ? "forward" : "back"} ${formatMinutes(Math.abs(change.deltaMinutes))}`
                          : ""}
                      </span>
                    }
                  />
                ) : (
                  link
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SelectedDay({
  schedule,
  selected,
  change,
  dayHref,
  now,
  loading,
  runCount,
}: {
  schedule: ScheduleDetail;
  selected: NonNullable<ScheduleCalendar["selected"]>;
  change: ScheduleClockChange | undefined;
  dayHref: (date: string) => string;
  now: number;
  loading: boolean;
  /** How many runs the day has left, where that's known beyond the runs listed. */
  runCount?: number;
}) {
  const userTimeZone = useUserTimeZone();
  const timezone = schedule.timezone;
  const showUserTime = userTimeZone !== timezone;
  const hasWindow = schedule.window !== undefined;
  const today = dateInZone(new Date(now), timezone);
  const runs = selected.runs.map(([cronAt, startAt]) => ({
    nominalAt: new Date(cronAt),
    effectiveAt: new Date(startAt),
  }));
  const { previousDay, nextDay } = selected;
  const nextRunAt = schedule.nextRuns[0] ? new Date(schedule.nextRuns[0].effectiveAt).getTime() : 0;
  const movedAt = new Map(
    (change?.moved ?? []).map((moved) => [new Date(moved.at).getTime(), moved.cronTime] as const)
  );
  const columns = showUserTime ? 3 : 2;
  const changeAt = change ? new Date(change.at).getTime() : undefined;
  const changeIndex =
    changeAt === undefined ? -1 : runs.findIndex((run) => run.effectiveAt.getTime() > changeAt);

  // The sun carries the colour; the words stay the table's own.
  const changeRow = change ? (
    <TableRow key="change">
      <TableCell colSpan={columns} className="py-2">
        <span className="flex items-start gap-1.5 whitespace-normal text-xs">
          <SunIcon className="mt-px size-3.5 flex-none text-warning" />
          <span className="flex flex-col gap-0.5">
            <span className="text-text-bright">
              Clocks go {change.deltaMinutes > 0 ? "forward" : "back"}{" "}
              {formatMinutes(Math.abs(change.deltaMinutes))}:{" "}
              {clockChangeLabel(new Date(change.at), change.deltaMinutes, timezone)}
            </span>
            {clockChangeEffect(change, timezone) ? (
              <span className="text-text-dimmed">{clockChangeEffect(change, timezone)}</span>
            ) : null}
          </span>
        </span>
      </TableCell>
    </TableRow>
  ) : null;

  return (
    <>
      <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-grid-bright py-1.5 pl-3 pr-2">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm text-text-bright">
            {formatDate(selected.day, {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: selected.day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
            })}
          </span>
          <span className="flex-none text-xs tabular-nums text-text-dimmed">
            {runs.length === 0
              ? "No runs"
              : `${runCount !== undefined ? runCount.toLocaleString("en-US") : selected.truncated ? `${runs.length}+` : runs.length} ${runs.length === 1 ? "run" : "runs"}${selected.day === today ? " left" : ""}`}
          </span>
        </span>
        <span className="flex flex-none items-center">
          <LinkButton
            to={previousDay ? dayHref(previousDay) : "#"}
            variant="minimal/small"
            LeadingIcon={ChevronLeftIcon}
            disabled={!previousDay}
            replace
            tooltip="Previous day with runs"
          />
          <LinkButton
            to={nextDay ? dayHref(nextDay) : "#"}
            variant="minimal/small"
            LeadingIcon={ChevronRightIcon}
            disabled={!nextDay}
            replace
            tooltip="Next day with runs"
          />
        </span>
      </div>
      {runs.length === 0 ? (
        <div className="flex flex-1 flex-col">
          {change ? (
            <Table variant="dimmed" showTopBorder={false}>
              <TableBody>{changeRow}</TableBody>
            </Table>
          ) : null}
          <DetailTabEmpty
            title="No runs this day"
            description={
              nextDay
                ? `The next day it runs is ${formatDate(nextDay, {
                    weekday: "long",
                    month: "short",
                    day: "numeric",
                  })}.`
                : undefined
            }
            action={
              nextDay ? (
                <LinkButton to={dayHref(nextDay)} variant="secondary/small" replace>
                  Go to that day
                </LinkButton>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto transition-opacity scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
            loading && "opacity-60"
          )}
        >
          <Table variant="dimmed" showTopBorder={false} stickyHeader>
            <TableHeader>
              <TableRow>
                {/* Set widths, so the columns stay where they are from one day to the next. */}
                <TableHeaderCell className="w-[36%]">
                  {showUserTime ? zoneCity(timezone) : `Time (${timezone})`}
                </TableHeaderCell>
                {showUserTime ? (
                  <TableHeaderCell className="w-[36%]">Your time</TableHeaderCell>
                ) : null}
                <TableHeaderCell alignment="right">Starts in</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run, index) => {
                const offsetMs = run.effectiveAt.getTime() - run.nominalAt.getTime();
                const isNext = run.effectiveAt.getTime() === nextRunAt;
                const movedFrom = movedAt.get(run.nominalAt.getTime());
                const userDate = dateInZone(run.effectiveAt, userTimeZone);
                return (
                  <Fragment key={run.nominalAt.getTime()}>
                    {index === changeIndex ? changeRow : null}
                    <TableRow>
                      {/* The next run: a rule down the row's edge, so the times stay in line. */}
                      <TableCell
                        className={cn(isNext && "shadow-[inset_2px_0_0_0_var(--color-schedules)]")}
                      >
                        <span className="flex flex-wrap items-center gap-x-2 tabular-nums">
                          <span className={cn("text-text-bright", isNext && "font-medium")}>
                            {formatTime(run.effectiveAt, timezone, hasWindow)}
                          </span>
                          {hasWindow && offsetMs > 0 ? (
                            <SimpleTooltip
                              button={
                                <span className="text-xs text-text-dimmed">
                                  +{formatOffset(offsetMs)}
                                </span>
                              }
                              content={`Cron time ${formatTime(run.nominalAt, timezone)}, spread by the ${schedule.window} window`}
                              disableHoverableContent
                            />
                          ) : null}
                          {movedFrom ? (
                            <SimpleTooltip
                              button={<SunIcon className="size-3.5 flex-none text-warning" />}
                              content={`Stands in for ${formatClock(movedFrom)}, which doesn't exist this day`}
                              disableHoverableContent
                            />
                          ) : null}
                        </span>
                      </TableCell>
                      {showUserTime ? (
                        <TableCell>
                          <span className="tabular-nums text-text-dimmed">
                            {userDate === selected.day
                              ? formatTime(run.effectiveAt, userTimeZone)
                              : formatInZone(run.effectiveAt, userTimeZone, {
                                  weekday: "short",
                                  hour: "numeric",
                                  minute: "2-digit",
                                })}
                          </span>
                        </TableCell>
                      ) : null}
                      <TableCell alignment="right">
                        <span
                          className={cn(
                            "tabular-nums",
                            isNext ? "text-text-bright" : "text-text-dimmed"
                          )}
                        >
                          {shortUntil(run.effectiveAt, now).replace(/^in /, "")}
                        </span>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
              {changeIndex === -1 && change ? changeRow : null}
              {selected.truncated ? (
                <TableRow>
                  <TableCell colSpan={columns} className="py-1.5">
                    <span className="text-xs text-text-dimmed">
                      Showing the first {runs.length} runs of the day
                    </span>
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

/** "+1h" when clocks go forward, "−1h" when they go back. */
export function clockChangeDelta(change: ScheduleClockChange) {
  return `${change.deltaMinutes > 0 ? "+" : "−"}${formatMinutes(Math.abs(change.deltaMinutes))}`;
}

/** A calendar date ("2026-11-19") formatted without any timezone shifting it. */
export function formatDate(date: string, opts: Intl.DateTimeFormatOptions) {
  return formatInZone(new Date(`${date}T12:00:00Z`), "UTC", opts);
}

/** Seconds into a day as "9 AM", or "9:07 AM" with `minutes`. */
export function formatSeconds(seconds: number, minutes: boolean) {
  const inDay = ((seconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS;
  return formatInZone(new Date(inDay * 1000), "UTC", {
    hour: "numeric",
    minute: minutes ? "2-digit" : undefined,
  });
}

/** "America/Los_Angeles" as "Los Angeles", for a column heading. */
function zoneCity(timezone: string) {
  return (timezone.split("/").pop() ?? timezone).replace(/_/g, " ");
}

export function shiftDate(date: string, days: number) {
  return new Date(new Date(`${date}T12:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function shiftMonth(month: string, months: number) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1 + months, 1)).toISOString().slice(0, 7);
}

function maxString(a: string, b: string) {
  return a > b ? a : b;
}

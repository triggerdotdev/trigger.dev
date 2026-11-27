import { SunIcon } from "@heroicons/react/20/solid";
import { Link } from "@remix-run/react";
import { type ReactNode } from "react";
import { LinkButton } from "~/components/primitives/Buttons";
import { DetailTabEmpty } from "~/components/primitives/detail/DetailSections";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import type {
  ScheduleCalendar,
  ScheduleClockChange,
  ScheduleDayRun,
} from "~/v3/scheduleUpcoming.server";
import { dateInZone, formatMinutes, minutesIntoDay } from "./scheduleTime";
import {
  type ScheduleCalendarNav,
  SelectedDay,
  UpcomingFooter,
  clockChangeDelta,
  formatDate,
  formatSeconds,
  shiftDate,
  useCalendarNav,
} from "./ScheduleUpcomingCalendar";
import { type ScheduleDetail } from "./ScheduleViews";

/*
 * The Upcoming tab for a schedule that runs every day, around the clock (every minute up to every
 * six hours). No day differs from the next, so a month of days says nothing: the tab shows the
 * rhythm instead: lanes from now at three zoom levels (the next hour, 24 hours, 7 days) over the
 * picked day's runs.
 */

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;

type Rhythm = {
  perDay: number;
  /** Seconds between runs when they are evenly spaced around the clock. */
  every: number | undefined;
  /** The longest a run starts after its cron time (a window spreads it), in seconds. */
  delay: number;
  /** Every run starts the same time after its cron time. */
  fixedDelay: boolean;
};

export function ScheduleUpcomingDense({
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
  calendar: ScheduleCalendar;
  /** A click already asks for another day than `calendar` has. */
  loading?: boolean;
  enableAction?: ReactNode;
  nav?: ScheduleCalendarNav;
}) {
  const nav = useCalendarNav(pageNav);
  const timezone = schedule.timezone;
  const active = schedule.active;

  const today = dateInZone(new Date(now), timezone);
  const currentMonth = today.slice(0, 7);
  const nowSeconds = minutesIntoDay(new Date(now), timezone) * 60;
  const day = calendar.selected?.day ?? today;

  const href = (changes: Record<string, string | undefined>) => {
    const params = new URLSearchParams(nav.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) params.delete(key);
      else params.set(key, value);
    }
    const search = params.toString();
    return search ? `?${search}` : nav.pathname;
  };
  /** Picks a day. The month goes with it, so the day's own runs are among the days loaded. */
  const dayHref = (date: string) =>
    href({
      day: date === today ? undefined : date,
      month: date.slice(0, 7) <= currentMonth ? undefined : date.slice(0, 7),
    });
  const todayHref = href({ day: undefined, month: undefined });

  const patternOn = new Map(calendar.days.map((entry) => [entry.date, entry.pattern] as const));
  const usual = usualRuns(calendar, today);
  /** A day's runs: its own where the day is loaded, an ordinary day's otherwise. */
  const runsOn = (date: string): ScheduleDayRun[] => {
    const pattern = patternOn.get(date);
    return pattern === undefined
      ? usual
      : pattern === null
        ? []
        : (calendar.patterns[pattern] ?? []);
  };
  const rhythm = rhythmOf(usual);
  const title = rhythm.every ? everyLabel(rhythm.every) : schedule.cronDescription;

  const changeDays = new Map(
    calendar.clockChanges.map(
      (change) => [dateInZone(new Date(change.at), timezone), change] as const
    )
  );
  const laterChanges = calendar.clockChanges.filter(
    (change) => dateInZone(new Date(change.at), timezone) >= today
  );

  const dayPanel = !active ? (
    <DetailTabEmpty
      title="Disabled"
      description="The faded marks are when it would run. Enable it to pick up from the next cron time."
      action={enableAction}
    />
  ) : calendar.selected ? (
    <SelectedDay
      schedule={schedule}
      selected={calendar.selected}
      change={changeDays.get(calendar.selected.day)}
      dayHref={dayHref}
      now={now}
      loading={loading}
      runCount={
        runsOn(calendar.selected.day).filter(
          (run) => calendar.selected?.day !== today || run[1] > nowSeconds
        ).length
      }
    />
  ) : (
    <DetailTabEmpty title="No upcoming runs" description="This cron has no future times." />
  );

  const todayButton = (
    <LinkButton to={todayHref} variant="secondary/small" replace>
      Today
    </LinkButton>
  );
  const rhythmTitle = (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate text-sm text-text-bright">{title}</span>
      <span className="flex-none text-xs tabular-nums text-text-dimmed">
        {rhythm.perDay.toLocaleString("en-US")} runs a day
      </span>
    </span>
  );

  return (
    <div
      className="@container/calendar flex h-full flex-col overflow-hidden"
      onClickCapture={nav.onClickCapture}
    >
      <PaneHeader>
        {rhythmTitle}
        {todayButton}
      </PaneHeader>
      <div className={cn("flex-none border-b border-grid-bright", loading && "opacity-60")}>
        {laneScales(rhythm.perDay).map((scale) => (
          <Lane
            key={scale.seconds}
            scale={scale}
            today={today}
            nowSeconds={nowSeconds}
            runsOn={runsOn}
            changes={laterChanges}
            timezone={timezone}
            dayHref={dayHref}
            active={active}
          />
        ))}
        <UpcomingFooter
          timezone={timezone}
          changes={laterChanges.slice(0, 2)}
          today={today}
          selected={day}
          dayHref={dayHref}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{dayPanel}</div>
    </div>
  );
}

function PaneHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 flex-none items-center justify-between gap-2 border-b border-grid-bright py-1.5 pl-3 pr-2">
      {children}
    </div>
  );
}

/** The runs most of the days ahead have: every day's, but for a day with a clock change. */
function usualRuns(calendar: ScheduleCalendar, today: string): ScheduleDayRun[] {
  const counts = new Map<number, number>();
  let usual: number | undefined;
  for (const entry of calendar.days) {
    if (entry.pattern === null || entry.date <= today) continue;
    const count = (counts.get(entry.pattern) ?? 0) + 1;
    counts.set(entry.pattern, count);
    if (usual === undefined || count > (counts.get(usual) ?? 0)) usual = entry.pattern;
  }
  return usual === undefined ? [] : (calendar.patterns[usual] ?? []);
}

function rhythmOf(runs: ScheduleDayRun[]): Rhythm {
  let every = runs.length > 0 ? runs[0][0] + DAY_SECONDS - runs[runs.length - 1][0] : undefined;
  for (let index = 1; index < runs.length; index++) {
    if (runs[index][0] - runs[index - 1][0] !== every) every = undefined;
  }
  const delays = runs.map((run) => run[1] - run[0]);
  const delay = Math.max(0, ...delays);
  return {
    perDay: runs.length,
    every,
    delay,
    fixedDelay: delays.every((value) => value === delay),
  };
}

/** "Every minute", "Every 5 minutes", "Every hour", "Every 6 hours", "Every 1h 30m". */
function everyLabel(seconds: number) {
  const minutes = seconds / 60;
  if (minutes === 1) return "Every minute";
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes === 60) return "Every hour";
  return minutes % 60 === 0 ? `Every ${minutes / 60} hours` : `Every ${formatMinutes(minutes)}`;
}

type LaneScale = {
  seconds: number;
  label: string;
  /** Seconds between the lane's labelled lines. */
  step: number;
};

const LANE_SCALES: LaneScale[] = [
  { seconds: HOUR_SECONDS, label: "Next hour", step: 15 * 60 },
  { seconds: 6 * HOUR_SECONDS, label: "Next 6 hours", step: HOUR_SECONDS },
  { seconds: DAY_SECONDS, label: "Next 24 hours", step: 3 * HOUR_SECONDS },
  { seconds: 7 * DAY_SECONDS, label: "Next 7 days", step: DAY_SECONDS },
  { seconds: 30 * DAY_SECONDS, label: "Next 30 days", step: 7 * DAY_SECONDS },
];
/** A lane with more runs than this draws where runs are, not each one. */
const LANE_MARKS = 240;

/**
 * Three zoom levels. The closest is the first to hold a handful of runs; the two after it are
 * whole days and longer, so an every-minute schedule isn't two solid bars in a row.
 */
function laneScales(perDay: number) {
  const first = LANE_SCALES.findIndex((scale) => (perDay * scale.seconds) / DAY_SECONDS >= 4);
  const close = LANE_SCALES[Math.min(first === -1 ? 2 : first, 2)];
  const wider = LANE_SCALES.filter(
    (scale) => scale.seconds > close.seconds && scale.seconds >= DAY_SECONDS
  );
  return [close, ...wider.slice(0, 2)];
}

/*
 * From now to the end of the lane's span on the schedule's wall clock: a mark per run, merged
 * into a bar where there are more runs than pixels, labelled lines at round times, and a sun
 * where the clocks change.
 */
function Lane({
  scale,
  today,
  nowSeconds,
  runsOn,
  changes,
  timezone,
  dayHref,
  active,
}: {
  scale: LaneScale;
  today: string;
  nowSeconds: number;
  runsOn: (date: string) => ScheduleDayRun[];
  changes: ScheduleClockChange[];
  timezone: string;
  dayHref: (date: string) => string;
  active: boolean;
}) {
  const span = scale.seconds;
  const dayCount = Math.ceil((nowSeconds + span) / DAY_SECONDS);
  const starts: number[] = [];
  const bands: Array<[number, number]> = [];
  for (let index = 0; index < dayCount; index++) {
    const base = index * DAY_SECONDS - nowSeconds;
    for (const run of runsOn(shiftDate(today, index))) {
      const start = base + run[1];
      if (start <= 0 || start > span) continue;
      starts.push(start);
      if (run[2] > run[1]) bands.push([Math.max(0, base + run[0]), Math.min(span, base + run[2])]);
    }
  }
  const cell = span / LANE_MARKS;
  const merged = starts.length > LANE_MARKS / 2;
  let marks = "";
  if (merged) {
    // More runs than marks: runs closer than two marks join into one bar.
    let from = starts[0];
    let to = from + cell;
    for (const start of starts) {
      if (start - to > cell) {
        marks += `M${from} 0h${to - from}v10h-${to - from}z`;
        from = start;
      }
      to = Math.max(to, start + cell);
    }
    marks += `M${from} 0h${to - from}v10h-${to - from}z`;
  } else {
    const width = Math.max(cell, Math.min(span / 80, span / Math.max(1, starts.length) / 2));
    marks = starts.map((start) => `M${start} 0h${width}v10h-${width}z`).join("");
  }

  // Labelled lines at round times: quarter hours, hours, midnights, Mondays.
  const lines: Array<{ at: number; label: string }> = [];
  if (scale.step === 7 * DAY_SECONDS) {
    for (let index = 1; index <= dayCount; index++) {
      const date = shiftDate(today, index);
      if (new Date(`${date}T12:00:00Z`).getUTCDay() !== 1) continue;
      lines.push({
        at: index * DAY_SECONDS - nowSeconds,
        label: formatDate(date, { month: "short", day: "numeric" }),
      });
    }
  } else {
    for (
      let wall = (Math.floor(nowSeconds / scale.step) + 1) * scale.step;
      wall - nowSeconds < span;
      wall += scale.step
    ) {
      const inDay = wall % DAY_SECONDS;
      lines.push({
        at: wall - nowSeconds,
        label:
          inDay === 0 || scale.step === DAY_SECONDS
            ? formatDate(shiftDate(today, Math.floor(wall / DAY_SECONDS)), { weekday: "short" })
            : formatSeconds(inDay, scale.step < HOUR_SECONDS),
      });
    }
  }

  const suns = changes.flatMap((change) => {
    const date = dateInZone(new Date(change.at), timezone);
    const days = Math.round(
      (new Date(`${date}T12:00:00Z`).getTime() - new Date(`${today}T12:00:00Z`).getTime()) /
        (DAY_SECONDS * 1000)
    );
    const at = days * DAY_SECONDS + minutesIntoDay(new Date(change.at), timezone) * 60 - nowSeconds;
    return at > 0 && at < span ? [{ at, date, change }] : [];
  });

  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_4.5rem] gap-x-3 border-b border-grid-dimmed px-3 pb-1.5 pt-3 [&:nth-last-child(2)]:border-b-0">
      <span className="text-xs leading-5 text-text-bright">{scale.label}</span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="relative mt-0.5 h-4">
          <span className="absolute inset-0 overflow-hidden rounded-xs bg-grid-bright">
            <svg
              viewBox={`0 0 ${span} 10`}
              preserveAspectRatio="none"
              className="absolute inset-0 size-full"
              aria-hidden
            >
              {merged ? null : (
                <path
                  d={bands
                    // A window too short to see past its run's mark isn't drawn.
                    .filter(([from, to]) => to - from > 2 * cell)
                    .map(([from, to]) => `M${from} 0h${to - from}v10h-${to - from}z`)
                    .join("")}
                  className={active ? "fill-schedules/35" : "fill-text-faint/35"}
                />
              )}
              <path d={marks} className={active ? "fill-schedules" : "fill-text-faint"} />
              <path
                d={lines.map((line) => `M${line.at} 0v10`).join("")}
                className="stroke-background-dimmed"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </span>
          {suns.map(({ at, date, change }) => (
            <SimpleTooltip
              key={date}
              asChild
              disableHoverableContent
              button={
                <Link
                  to={dayHref(date)}
                  replace
                  preventScrollReset
                  aria-label={`Clocks go ${change.deltaMinutes > 0 ? "forward" : "back"} on ${formatDate(date, { weekday: "short", month: "short", day: "numeric" })}`}
                  className="absolute top-1/2 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background-dimmed"
                  style={{ left: `${(at / span) * 100}%` }}
                >
                  <SunIcon className="size-3 text-warning" />
                </Link>
              }
              content={
                <span className="text-xs">
                  {formatDate(date, { weekday: "short", month: "short", day: "numeric" })}: clocks
                  go {change.deltaMinutes > 0 ? "forward" : "back"}{" "}
                  {formatMinutes(Math.abs(change.deltaMinutes))} ({clockChangeDelta(change)})
                </span>
              }
            />
          ))}
        </span>
        <span className="relative h-4 text-xxs tabular-nums text-text-dimmed">
          {lines
            // A label at the far end would run off the lane.
            .filter((line) => line.at / span < 0.94)
            .map((line) => (
              <span
                key={line.at}
                className="absolute whitespace-nowrap"
                style={{ left: `${(line.at / span) * 100}%` }}
              >
                {line.label}
              </span>
            ))}
        </span>
      </span>
      <span className="text-right text-xs tabular-nums leading-5 text-text-dimmed">
        {starts.length.toLocaleString("en-US")} {starts.length === 1 ? "run" : "runs"}
      </span>
    </div>
  );
}

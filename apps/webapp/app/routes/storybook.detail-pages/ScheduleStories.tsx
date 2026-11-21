import { BoltSlashIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DetailPageTitle } from "~/components/primitives/detail/DetailPage";
import { NavBar } from "~/components/primitives/PageHeader";
import { type SchedulePageTab, SchedulePageView } from "~/components/schedules/SchedulePageView";
import { type ScheduleDetail } from "~/components/schedules/ScheduleViews";
import type { ScheduleCalendar } from "~/v3/scheduleUpcoming.server";

/* A schedule's page with static data, as the real one opens from a scheduled task's Schedules
   tab. */

const HOUR = 60 * 60 * 1000;

function nextWeekdays(count: number, hourUtc: number) {
  const runs: Date[] = [];
  const day = new Date();
  day.setUTCHours(hourUtc, 0, 0, 0);
  while (runs.length < count) {
    if (day.getTime() > Date.now() && day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      runs.push(new Date(day));
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return runs;
}

type MockRun = {
  friendlyId: string;
  status: ScheduleDetail["runs"][number]["status"];
  ago: number;
};

function mockRuns(rows: MockRun[]) {
  // Only the fields the schedule views read; the rest of a runs list row isn't needed here.
  return rows.map((row, index) => ({
    id: `run-${index}`,
    friendlyId: row.friendlyId,
    status: row.status,
    createdAt: new Date(Date.now() - row.ago).toISOString(),
    usageDurationMs: 2_400 + index * 310,
  })) as unknown as ScheduleDetail["runs"];
}

const acme: ScheduleDetail = {
  id: "schedule-acme",
  friendlyId: "sched_rqjwgoqwantc95s6ttonf",
  type: "IMPERATIVE",
  taskIdentifier: "sync.hourly",
  cron: "0 9 * * 1-5",
  cronDescription: "At 09:00 AM, Monday through Friday",
  timezone: "UTC",
  window: "15m",
  windowSource: "explicit",
  externalId: "org_acme",
  deduplicationKey: "acme-weekday-sync",
  userProvidedDeduplicationKey: true,
  active: true,
  environments: [
    { id: "env-prod", type: "PRODUCTION" },
  ] as unknown as ScheduleDetail["environments"],
  nextRuns: nextWeekdays(25, 9).map((date) => ({
    nominalAt: date,
    effectiveAt: new Date(date.getTime() + 7 * 60 * 1000),
    rangeEndAt: new Date(date.getTime() + 15 * 60 * 1000),
  })),
  runs: mockRuns([
    { friendlyId: "run_cmwmh2k9q0001", status: "COMPLETED_SUCCESSFULLY", ago: 7 * HOUR },
    { friendlyId: "run_cmwmf8d1x0002", status: "COMPLETED_SUCCESSFULLY", ago: 31 * HOUR },
    { friendlyId: "run_cmwmd4n7c0003", status: "COMPLETED_WITH_ERRORS", ago: 55 * HOUR },
    { friendlyId: "run_cmwmb1v2w0004", status: "COMPLETED_SUCCESSFULLY", ago: 127 * HOUR },
    { friendlyId: "run_cmwm9z6r30005", status: "COMPLETED_SUCCESSFULLY", ago: 151 * HOUR },
  ]),
};

const DAY = 24 * HOUR;

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** The picked day for a static calendar: the day of the schedule's next run. */
function selectedDay(schedule: ScheduleDetail, nextDay: string | undefined) {
  const day = isoDate(new Date(schedule.nextRuns[0].nominalAt));
  return {
    day,
    runs: schedule.nextRuns
      .filter((run) => isoDate(new Date(run.nominalAt)) === day)
      .map((run): [number, number] => [
        new Date(run.nominalAt).getTime(),
        new Date(run.effectiveAt).getTime(),
      ]),
    truncated: false,
    previousDay: undefined,
    nextDay,
  };
}

/** Six weeks from this week (UTC), running on weekdays at 09:00 with a 15 minute window. */
function weekdayCalendar(schedule: ScheduleDetail): ScheduleCalendar {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return {
    view: "month",
    dense: false,
    month: undefined,
    days: Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start.getTime() + index * DAY);
      return {
        date: isoDate(day),
        pattern: day.getUTCDay() !== 0 && day.getUTCDay() !== 6 ? 0 : null,
      };
    }),
    // Cron time 09:00, starts 09:07, window ends 09:15, in seconds into the day.
    patterns: [[[9 * 3600, 9 * 3600 + 7 * 60, 9 * 3600 + 15 * 60]]],
    clockChanges: [],
    selected: selectedDay(schedule, isoDate(new Date(schedule.nextRuns[1].nominalAt))),
  };
}

/** The first of each quarter at 09:00 UTC, from now. */
function nextQuarters(count: number) {
  const runs: Date[] = [];
  const day = new Date();
  day.setUTCHours(9, 0, 0, 0);
  day.setUTCDate(1);
  while (runs.length < count) {
    if (day.getTime() > Date.now() && day.getUTCMonth() % 3 === 0) runs.push(new Date(day));
    day.setUTCMonth(day.getUTCMonth() + 1);
  }
  return runs;
}

const quarterly: ScheduleDetail = {
  ...acme,
  id: "schedule-quarterly",
  friendlyId: "sched_1uns2t1xz6kdq8s9uhgq4",
  cron: "0 9 1 1,4,7,10 *",
  cronDescription: "At 09:00 AM, on day 1 of the month, only in January, April, July, and October",
  window: undefined,
  windowSource: undefined,
  externalId: "quarterly_report",
  deduplicationKey: "quarterly-report",
  nextRuns: nextQuarters(4).map((date) => ({
    nominalAt: date,
    effectiveAt: date,
    rangeEndAt: date,
  })),
};

/** Twelve months from this one (UTC), running on the first of each quarter at 09:00. */
function quarterlyCalendar(schedule: ScheduleDetail): ScheduleCalendar {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(1);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  const days: ScheduleCalendar["days"] = [];
  for (let day = new Date(start); day < end; day = new Date(day.getTime() + DAY)) {
    days.push({
      date: isoDate(day),
      pattern: day.getUTCDate() === 1 && day.getUTCMonth() % 3 === 0 ? 0 : null,
    });
  }
  return {
    view: "year",
    dense: false,
    month: undefined,
    days,
    patterns: [[[9 * 3600, 9 * 3600, 9 * 3600]]],
    clockChanges: [],
    selected: selectedDay(schedule, isoDate(new Date(schedule.nextRuns[1].nominalAt))),
  };
}

const QUARTER_HOUR = 15 * 60 * 1000;

const everyQuarterHour: ScheduleDetail = {
  ...acme,
  id: "schedule-dense",
  friendlyId: "sched_edu7dr66xorwut3x5bjtn",
  cron: "*/15 * * * *",
  cronDescription: "Every 15 minutes",
  window: undefined,
  windowSource: undefined,
  externalId: "every_15_minutes",
  deduplicationKey: "every-15-minutes",
  nextRuns: [new Date(Math.ceil((Date.now() + 1) / QUARTER_HOUR) * QUARTER_HOUR)].map((date) => ({
    nominalAt: date,
    effectiveAt: date,
    rangeEndAt: date,
  })),
};

/** Every 15 minutes (UTC), every day: a dense schedule, with the rest of today's runs picked. */
function denseCalendar(): ScheduleCalendar {
  const now = Date.now();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const runs: Array<[number, number]> = [];
  for (let at = start.getTime(); at < start.getTime() + DAY; at += QUARTER_HOUR) {
    if (at > now) runs.push([at, at]);
  }
  return {
    ...weekdayCalendar(acme),
    dense: true,
    days: Array.from({ length: 42 }, (_, index) => ({
      date: isoDate(new Date(start.getTime() + index * DAY)),
      pattern: 0,
    })),
    patterns: [Array.from({ length: 96 }, (_, index) => [index * 900, index * 900, index * 900])],
    selected: {
      day: isoDate(start),
      runs,
      truncated: false,
      previousDay: undefined,
      nextDay: isoDate(new Date(start.getTime() + DAY)),
    },
  };
}

/**
 * org_acme on its schedule page; with `sparse`, a quarterly schedule's year of months; with
 * `dense`, an every-15-minutes schedule's rhythm.
 */
export function ScheduleStory({ sparse, dense }: { sparse?: boolean; dense?: boolean } = {}) {
  const schedule = dense ? everyQuarterHour : sparse ? quarterly : acme;
  const [tab, setTab] = useState<SchedulePageTab>("upcoming");
  return (
    <>
      <NavBar>
        <DetailPageTitle
          title={schedule.externalId ?? schedule.friendlyId}
          crumbs={[
            { to: "#", text: "Tasks" },
            { to: "#", text: "sync.hourly" },
          ]}
        />
      </NavBar>
      <SchedulePageView
        schedule={schedule}
        calendar={
          dense ? denseCalendar() : sparse ? quarterlyCalendar(schedule) : weekdayCalendar(schedule)
        }
        runs={acme.runs}
        taskLink="#"
        tab={tab}
        onTabChange={setTab}
        secondaryActions={
          <>
            <Button
              variant="secondary/small"
              LeadingIcon={BoltSlashIcon}
              leadingIconClassName="text-text-dimmed"
            >
              Disable
            </Button>
            <Button variant="danger/small" LeadingIcon={TrashIcon}>
              Delete…
            </Button>
          </>
        }
        primaryAction={
          <Button variant="primary/small" LeadingIcon={PencilSquareIcon}>
            Edit…
          </Button>
        }
      />
    </>
  );
}

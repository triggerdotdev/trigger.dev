import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { scheduleCalendarKey } from "~/components/schedules/scheduleTime";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { calculateScheduleCalendar } from "~/v3/scheduleUpcoming.server";

/*
 * The schedule page's Upcoming calendar on its own: picking a day or paging a month loads this
 * instead of rerunning the page's loader, which also queries the schedule's runs.
 */

const ParamsSchema = EnvironmentParamSchema.extend({ scheduleParam: z.string() });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, scheduleParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const result = await new ViewSchedulePresenter().call({
    userId,
    projectId: project.id,
    friendlyId: scheduleParam,
    environmentId: environment.id,
    includeRunHistory: false,
    nextRunCount: 1,
  });
  const { searchParams } = new URL(request.url);
  if (!result) {
    // Not a 404 throw: the page's fetcher loads this again after the schedule is deleted, and a
    // throw there would replace the page with an error before it goes back to the task. With no
    // key, the answer matches nothing the page asks for.
    return typedjson({ calendar: undefined, calendarKey: undefined, at: searchParams.get("at") });
  }

  const calendar = calculateScheduleCalendar({
    cron: result.schedule.cron,
    timezone: result.schedule.timezone,
    runTiming: result.runTiming,
    active: result.schedule.active,
    month: searchParams.get("month"),
    day: searchParams.get("day"),
    view: searchParams.get("view"),
  });

  return typedjson({
    calendar,
    calendarKey: scheduleCalendarKey(searchParams),
    // Which load of the page asked: an answer to an earlier one is out of date after an edit.
    at: searchParams.get("at"),
  });
};

import {
  type ShouldRevalidateFunction,
  useFetcher,
  useLocation,
  useNavigate,
  useRevalidator,
} from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect, useMemo, useState } from "react";
import { typedjson, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { scheduleAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DetailPageTitle, useDetailTab } from "~/components/primitives/detail/DetailPage";
import { NavBar } from "~/components/primitives/PageHeader";
import { useToast } from "~/components/primitives/Toast";
import { type SchedulePageTab, SchedulePageView } from "~/components/schedules/SchedulePageView";
import {
  pickCalendarDay,
  scheduleCalendarKey,
  withScheduleCalendarKey,
} from "~/components/schedules/scheduleTime";
import {
  ScheduleDeleteButton,
  ScheduleEditButton,
  ScheduleFormDialog,
  ScheduleToggleButton,
  useFetcherResult,
} from "~/components/schedules/ScheduleViews";
import { $replica } from "~/db.server";
import type { loader as calendarLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam.calendar";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUserId } from "~/services/session.server";
import type { Handle } from "~/utils/handle";
import { pageMeta } from "~/utils/pageTitle";
import {
  EnvironmentParamSchema,
  v3EnvironmentPath,
  v3ScheduleCalendarResourcePath,
  v3ScheduledTaskPath,
  v3SchedulePath,
} from "~/utils/pathBuilder";
import { calculateScheduleCalendar, type ScheduleCalendar } from "~/v3/scheduleUpcoming.server";

/* A schedule's page, opened from a row on the scheduled task's Schedules tab. */

const ParamsSchema = EnvironmentParamSchema.extend({
  taskParam: z.string(),
  scheduleParam: z.string(),
});

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.schedule.externalId ?? params.scheduleParam ?? "Schedule",
  "Schedules",
]);

export const handle: Handle = {
  agentPageContext: (data) => scheduleAgentPageContext(data),
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, taskParam, scheduleParam } =
    ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const result = await new ViewSchedulePresenter().call({
    userId,
    projectId: project.id,
    friendlyId: scheduleParam,
    environmentId: environment.id,
    // The Runs tab's page of runs is loaded below.
    includeRunHistory: false,
    nextRunCount: 1,
  });
  if (!result || result.schedule.taskIdentifier !== taskParam) {
    throw new Response("Schedule not found", { status: 404 });
  }

  // The Runs tab: a page of this schedule's runs from the last 31 days.
  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const { runs } = await new NextRunListPresenter($replica, clickhouse).call(
    project.organizationId,
    environment.id,
    { projectId: project.id, scheduleId: result.schedule.id, pageSize: 25, period: "31d" }
  );

  // The Upcoming tab's calendar: `month` pages it, `day` picks a day, `view` forces month or year.
  const { searchParams } = new URL(request.url);
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
    schedule: result.schedule,
    runs,
    calendar,
    calendarKey: scheduleCalendarKey(searchParams),
    loadedAt: Date.now(),
  });
};

/**
 * Deleting the schedule leaves nothing for this page to load: skip the reload after the delete
 * post, and the page goes back to the task's schedules once the result lands.
 */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formData,
  defaultShouldRevalidate,
}) => (formData?.get("action") === "delete" ? false : defaultShouldRevalidate);

/**
 * The calendar the page shows, and the way to change it. Picking a day or paging the calendar
 * happens here and in the address bar, not as a navigation: a navigation reloads the layouts
 * around the page and repaints all of it, which a day click doesn't need. A day among the days
 * already loaded is worked out from them at once. Anything else (another month or view, a day
 * with a clock change) comes from the calendar's own route, and the last calendar stays on screen
 * while that loads.
 */
function useScheduleCalendar(
  loaded: { calendar: ScheduleCalendar | undefined; calendarKey: string; loadedAt: number },
  path: string,
  timezone: string
) {
  const location = useLocation();
  // The router's own idea of the calendar changes only on a real navigation (back, forward, a
  // link to another schedule), and then the page follows it.
  const routerKey = scheduleCalendarKey(new URLSearchParams(location.search));
  const origin = `${location.pathname}?${routerKey}`;
  const [asked, setAsked] = useState({ key: routerKey, origin });
  if (asked.origin !== origin) setAsked({ key: routerKey, origin });
  const key = asked.origin === origin ? asked.key : routerKey;

  // The address bar says what's on screen, so a reload or a copied link opens the same calendar.
  // The router rewrites it from its own search params on a navigation (the Runs tab), hence
  // `location` here.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.pathname !== location.pathname) return;
    if (scheduleCalendarKey(url.searchParams) === key) return;
    url.search = withScheduleCalendarKey(url.search, key);
    window.history.replaceState(window.history.state, "", url);
  }, [key, location]);

  const fetcher = useTypedFetcher<typeof calendarLoader>();
  const load = fetcher.load;
  const { calendar, calendarKey, loadedAt } = loaded;
  const fetched = fetcher.data?.at === String(loadedAt) ? fetcher.data : undefined;
  // Memoized: the calendar with a day picked is a new object, and it is state below.
  const current = useMemo(
    () => answerFor(key, [{ calendar, calendarKey }, fetched], timezone, loadedAt),
    [calendar, calendarKey, fetched, key, timezone, loadedAt]
  );

  const answered = current !== undefined;
  useEffect(() => {
    if (!answered) load(`${path}?${key ? `${key}&` : ""}at=${loadedAt}`);
  }, [answered, key, path, load, loadedAt]);

  // The last calendar that answered, kept in state so it stays up while the next loads.
  const [shown, setShown] = useState(calendar);
  if (current && current.calendar !== shown) setShown(current.calendar);

  const params = new URLSearchParams(key);
  return {
    calendar: current ? current.calendar : shown,
    loading: !answered,
    /** The calendar's search params, for a navigation to carry along (the router's are older). */
    params: {
      month: params.get("month") ?? undefined,
      day: params.get("day") ?? undefined,
      view: params.get("view") ?? undefined,
    },
    nav: {
      search: withScheduleCalendarKey(location.search, key),
      go: (to: string) =>
        setAsked({
          key: scheduleCalendarKey(new URLSearchParams(to.startsWith("?") ? to : "")),
          origin,
        }),
    },
  };
}

/** `calendarKey` is undefined when the schedule is gone (deleted since the page loaded). */
type CalendarAnswer = { calendar: ScheduleCalendar | undefined; calendarKey: string | undefined };

/**
 * The calendar for `key` from the answers in hand, freshest first: the one loaded for exactly that
 * key, or one of the same month and view with the day picked from its days. Undefined when the
 * calendar's route has to be asked.
 */
function answerFor(
  key: string,
  answers: Array<CalendarAnswer | undefined>,
  timezone: string,
  now: number
): { calendar: ScheduleCalendar | undefined } | undefined {
  const exact = answers.find((answer) => answer?.calendarKey === key);
  if (exact) return { calendar: exact.calendar };
  const day = new URLSearchParams(key).get("day");
  if (!day) return undefined;
  for (const answer of answers) {
    if (!answer?.calendar || answer.calendarKey === undefined) continue;
    if (withoutDay(answer.calendarKey) !== withoutDay(key)) continue;
    const picked = pickCalendarDay(answer.calendar, day, timezone, now);
    if (picked) return { calendar: picked };
  }
  return undefined;
}

/** A calendar key without its day: the month and view it draws. */
function withoutDay(key: string) {
  const params = new URLSearchParams(key);
  params.delete("day");
  return params.toString();
}

export default function Page() {
  const {
    schedule,
    runs,
    calendar: loadedCalendar,
    calendarKey,
    loadedAt,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigate = useNavigate();
  const toast = useToast();
  const revalidator = useRevalidator();
  const [tab, setTab] = useDetailTab<SchedulePageTab>(["upcoming", "runs"]);
  const [editing, setEditing] = useState(false);

  const taskPath = v3ScheduledTaskPath(organization, project, environment, schedule.taskIdentifier);
  const backToSchedules = `${taskPath}?tab=schedules`;
  const actionPath = v3SchedulePath(organization, project, environment, schedule);
  const {
    calendar,
    loading: calendarLoading,
    params: calendarParams,
    nav: calendarNav,
  } = useScheduleCalendar(
    { calendar: loadedCalendar, calendarKey, loadedAt },
    v3ScheduleCalendarResourcePath(organization, project, environment, schedule),
    schedule.timezone
  );

  const activeToggleFetcher = useFetcher<{ ok: boolean; active?: boolean; message?: string }>();
  const deleteFetcher = useFetcher<{ ok: boolean; message?: string }>();

  useFetcherResult(activeToggleFetcher, (data) => {
    if (data.ok) {
      toast.success(data.active ? "Schedule enabled" : "Schedule disabled");
      revalidator.revalidate();
    } else if (data.message) toast.error(data.message);
  });
  useFetcherResult(deleteFetcher, (data) => {
    if (data.ok) {
      toast.success(data.message ?? "Schedule deleted");
      navigate(backToSchedules);
    } else if (data.message) toast.error(data.message);
  });

  const isImperative = schedule.type === "IMPERATIVE";

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={schedule.externalId ?? schedule.friendlyId}
          crumbs={[
            { to: v3EnvironmentPath(organization, project, environment), text: "Tasks" },
            { to: backToSchedules, text: schedule.taskIdentifier },
          ]}
        />
      </NavBar>
      <PageBody scrollable={false}>
        <SchedulePageView
          schedule={schedule}
          loadedAt={loadedAt}
          calendar={calendar}
          calendarLoading={calendarLoading}
          calendarNav={calendarNav}
          runs={runs}
          taskLink={taskPath}
          tab={tab}
          onTabChange={(next) => setTab(next, calendarParams)}
          secondaryActions={
            isImperative ? (
              <>
                <ScheduleToggleButton
                  schedule={schedule}
                  actionPath={actionPath}
                  fetcher={activeToggleFetcher}
                />
                <ScheduleDeleteButton
                  schedule={schedule}
                  actionPath={actionPath}
                  fetcher={deleteFetcher}
                />
              </>
            ) : undefined
          }
          enableAction={
            isImperative ? (
              <ScheduleToggleButton
                schedule={schedule}
                actionPath={actionPath}
                fetcher={activeToggleFetcher}
              />
            ) : undefined
          }
          primaryAction={
            isImperative ? (
              <ScheduleEditButton variant="primary/small" onEdit={() => setEditing(true)} />
            ) : undefined
          }
        />
      </PageBody>
      <ScheduleFormDialog
        mode={editing ? schedule.friendlyId : undefined}
        onClose={() => setEditing(false)}
      />
    </PageContainer>
  );
}

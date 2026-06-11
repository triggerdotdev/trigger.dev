import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense, useCallback, useEffect, useMemo } from "react";
import { TypedAwait, typeddefer, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { Sheet, SheetContent } from "~/components/primitives/SheetV3";
import { ScheduleInspector } from "~/components/schedules/ScheduleInspector";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  type TableVariant,
} from "~/components/primitives/Table";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { ScheduleTypeIcon, scheduleTypeName } from "~/components/runs/v3/ScheduleType";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import type { loader as scheduleDetailLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam/route";
import {
  TaskDetailPresenter,
  type TaskActivity,
  type TaskDetail,
} from "~/presenters/v3/TaskDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3CreateBulkActionPath,
  v3EnvironmentPath,
  v3RunsPath,
  v3SchedulePath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const slug = (data as { task?: TaskDetail | null } | undefined)?.task?.slug;
  return [
    { title: slug ? `${slug} | Scheduled tasks | Trigger.dev` : "Scheduled task | Trigger.dev" },
  ];
};

const ParamsSchema = EnvironmentParamSchema.extend({
  taskParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam, taskParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? undefined;
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const from = fromStr ? parseInt(fromStr, 10) : undefined;
  const to = toStr ? parseInt(toStr, 10) : undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const directionRaw = url.searchParams.get("direction") ?? undefined;
  const direction = directionRaw ? DirectionSchema.parse(directionRaw) : undefined;

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );

  const taskPresenter = new TaskDetailPresenter($replica, clickhouse);
  const task = await taskPresenter.findTask({
    environmentId: environment.id,
    environmentType: environment.type,
    taskSlug: taskParam,
    expectedTriggerSource: "SCHEDULED",
  });

  if (!task) throw new Response("Scheduled task not found", { status: 404 });

  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  const activity = taskPresenter
    .getActivity({
      environmentId: environment.id,
      taskSlug: task.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] } satisfies TaskActivity));

  const pageRaw = parseInt(url.searchParams.get("page") ?? "1", 10);
  const schedulesPage = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  const scheduleList = new ScheduleListPresenter()
    .call({
      userId,
      projectId: project.id,
      environmentId: environment.id,
      tasks: [task.slug],
      page: schedulesPage,
    })
    .catch(() => null);

  const runList = new NextRunListPresenter($replica, clickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [task.slug],
      period,
      from,
      to,
      cursor,
      direction,
    })
    .catch(() => null);

  return typeddefer({
    task,
    activity,
    scheduleList,
    runList,
  });
};

export default function Page() {
  const { task, activity, scheduleList, runList } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const scheduledTasksListingPath = v3EnvironmentPath(organization, project, environment);
  const testPath = v3TestTaskPath(organization, project, environment, {
    taskIdentifier: task.slug,
  });

  const filters: TaskRunListSearchFilters = useMemo(() => ({ tasks: [task.slug] }), [task.slug]);

  const search = useSearchParams();
  const openScheduleId = search.value("schedule");
  const openSchedule = useCallback(
    (friendlyId: string) => search.replace({ schedule: friendlyId }),
    [search]
  );
  const closeSchedule = useCallback(() => search.del("schedule"), [search]);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          backButton={{ to: scheduledTasksListingPath, text: "Tasks" }}
          title={
            <span className="flex items-center gap-1">
              <ClockIcon className="size-4.5 text-schedules" />
              <span>{task.slug}</span>
            </span>
          }
        />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="scheduled-task-main" min="300px">
            <ResizablePanelGroup orientation="vertical" className="max-h-full">
              {/* Activity chart + filters */}
              <ResizablePanel id="scheduled-task-activity" min="144px" default="200px">
                <div className="flex h-full flex-col gap-3 overflow-hidden bg-background-bright py-2 pl-2 pr-4">
                  <div className="flex items-center gap-2">
                    <TimeFilter defaultPeriod="7d" labelName="Runs" />
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col">
                    <Suspense fallback={<ActivityChartSkeleton />}>
                      <TypedAwait resolve={activity} errorElement={<ActivityChartSkeleton />}>
                        {(result) => <ActivityChart activity={result} />}
                      </TypedAwait>
                    </Suspense>
                  </div>
                </div>
              </ResizablePanel>

              <ResizableHandle id="scheduled-task-activity-handle" />

              {/* Runs table */}
              <ResizablePanel id="scheduled-task-content" min="160px">
                <div className="grid h-full grid-rows-[2.25rem_1fr] overflow-hidden">
                  <div className="flex items-center justify-between border-b border-grid-dimmed bg-background-bright pl-3 pr-2">
                    <Paragraph variant="small/bright">Runs</Paragraph>
                    <div className="flex items-center gap-1.5">
                      <LinkButton
                        variant="secondary/small"
                        to={v3RunsPath(organization, project, environment, filters)}
                        LeadingIcon={RunsIcon}
                      >
                        View all runs
                      </LinkButton>
                      <LinkButton
                        variant="secondary/small"
                        to={v3CreateBulkActionPath(
                          organization,
                          project,
                          environment,
                          filters,
                          "filter",
                          "replay"
                        )}
                        LeadingIcon={ListCheckedIcon}
                        leadingIconClassName="-mx-1"
                      >
                        Bulk replay…
                      </LinkButton>
                      <Suspense fallback={null}>
                        <TypedAwait resolve={runList} errorElement={null}>
                          {(list) => (list ? <ListPagination list={list} /> : null)}
                        </TypedAwait>
                      </Suspense>
                    </div>
                  </div>
                  <div className="min-h-0 overflow-hidden">
                    <Suspense fallback={<TableLoading />}>
                      <TypedAwait resolve={runList} errorElement={<TableLoading />}>
                        {(list) =>
                          list ? (
                            <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                              <TaskRunsTable
                                total={list.runs.length}
                                hasFilters={list.hasFilters}
                                filters={list.filters}
                                runs={list.runs}
                                variant="dimmed"
                                showTopBorder={false}
                              />
                            </div>
                          ) : (
                            <TableLoading />
                          )
                        }
                      </TypedAwait>
                    </Suspense>
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle id="scheduled-task-detail-handle" />
          <ResizablePanel
            id="scheduled-task-detail"
            min="280px"
            default="380px"
            max="500px"
            isStaticAtRest
          >
            <ScheduledTaskDetailSidebar
              task={task}
              testPath={testPath}
              scheduleList={scheduleList}
              onSelectSchedule={openSchedule}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>

      <ScheduleSheet
        openScheduleId={openScheduleId}
        organization={organization}
        project={project}
        environment={environment}
        onClose={closeSchedule}
      />
    </PageContainer>
  );
}

function ScheduleSheet({
  openScheduleId,
  organization,
  project,
  environment,
  onClose,
}: {
  openScheduleId: string | undefined;
  organization: ReturnType<typeof useOrganization>;
  project: ReturnType<typeof useProject>;
  environment: ReturnType<typeof useEnvironment>;
  onClose: () => void;
}) {
  const fetcher = useTypedFetcher<typeof scheduleDetailLoader>();
  const detailPath = openScheduleId
    ? v3SchedulePath(organization, project, environment, { friendlyId: openScheduleId })
    : undefined;

  useEffect(() => {
    if (detailPath) fetcher.load(detailPath);
  }, [detailPath]);

  const schedule = fetcher.data?.schedule;
  const isLoading = fetcher.state === "loading" || (!!openScheduleId && !schedule);

  return (
    <Sheet open={!!openScheduleId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-[480px] max-w-none border-l border-grid-dimmed bg-background-bright p-0 sm:max-w-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {isLoading || !schedule ? (
          <TableLoading />
        ) : (
          <ScheduleInspector schedule={schedule} actionPath={detailPath} />
        )}
      </SheetContent>
    </Sheet>
  );
}

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;

function ScheduledTaskDetailSidebar({
  task,
  testPath,
  scheduleList,
  onSelectSchedule,
}: { task: TaskDetail; testPath: string; onSelectSchedule: (friendlyId: string) => void } & Pick<
  LoaderData,
  "scheduleList"
>) {
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden border-b border-grid-dimmed px-3 py-2">
        <Header2 className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <ClockIcon className="size-4.5 shrink-0 text-schedules" />
          <span className="truncate">{task.slug}</span>
        </Header2>
        <LinkButton
          variant="primary/small"
          to={testPath}
          LeadingIcon={BeakerIcon}
          iconSpacing="gap-x-2"
          leadingIconClassName="-mx-2"
          className="shrink-0"
        >
          Test schedule
        </LinkButton>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Property.Table>
          <Property.Item>
            <Property.Label>Identifier</Property.Label>
            <Property.Value>
              <CopyableText value={task.slug} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>File path</Property.Label>
            <Property.Value>
              <CopyableText value={task.filePath} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Type</Property.Label>
            <Property.Value>
              <Paragraph variant="small">Scheduled task</Paragraph>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={task.createdAt} />
            </Property.Value>
          </Property.Item>
        </Property.Table>
        <div className="mt-4 flex flex-col gap-2">
          <Header3>Schedules</Header3>
          <div className="-mx-3 overflow-hidden border-y border-grid-dimmed">
            <Suspense fallback={<TableLoading />}>
              <TypedAwait resolve={scheduleList} errorElement={<TableLoading />}>
                {(list) =>
                  list ? (
                    <SchedulesMiniTable
                      schedules={list.schedules}
                      variant="bright"
                      onSelectSchedule={onSelectSchedule}
                    />
                  ) : (
                    <TableLoading />
                  )
                }
              </TypedAwait>
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}

type ScheduleRow = {
  id: string;
  friendlyId: string;
  type: "DECLARATIVE" | "IMPERATIVE";
  cron: string;
  cronDescription: string;
  externalId: string | null;
  nextRun: Date;
  lastRun: Date | undefined;
  active: boolean;
};

function SchedulesMiniTable({
  schedules,
  variant,
  onSelectSchedule,
}: {
  schedules: ScheduleRow[];
  variant?: TableVariant;
  onSelectSchedule: (friendlyId: string) => void;
}) {
  if (schedules.length === 0) {
    return (
      <Table variant={variant}>
        <TableBody>
          <TableBlankRow colSpan={6}>
            <Paragraph variant="small" className="flex items-center justify-center">
              No schedules attached to this task yet.
            </Paragraph>
          </TableBlankRow>
        </TableBody>
      </Table>
    );
  }

  return (
    <Table variant={variant}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Schedule ID</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Cron</TableHeaderCell>
          <TableHeaderCell>External ID</TableHeaderCell>
          <TableHeaderCell>Next run</TableHeaderCell>
          <TableHeaderCell>Last run</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.map((schedule) => {
          const open = () => onSelectSchedule(schedule.friendlyId);
          return (
            <TableRow key={schedule.id} className="group">
              <TableCell onClick={open} isTabbableCell>
                <span className="font-mono text-xs">{schedule.friendlyId}</span>
              </TableCell>
              <TableCell onClick={open}>
                <span className="inline-flex items-center gap-1 text-xs text-text-dimmed">
                  <ScheduleTypeIcon
                    type={schedule.type}
                    className={schedule.type === "DECLARATIVE" ? "text-sky-500" : "text-teal-500"}
                  />
                  {scheduleTypeName(schedule.type)}
                </span>
              </TableCell>
              <TableCell onClick={open}>
                <span className="font-mono text-xs">{schedule.cron}</span>
              </TableCell>
              <TableCell onClick={open}>
                {schedule.externalId ? (
                  <span className="font-mono text-xs">{schedule.externalId}</span>
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </TableCell>
              <TableCell onClick={open}>
                <RelativeDateTime date={schedule.nextRun} />
              </TableCell>
              <TableCell onClick={open}>
                {schedule.lastRun ? (
                  <RelativeDateTime date={schedule.lastRun} />
                ) : (
                  <span className="text-text-dimmed">Never</span>
                )}
              </TableCell>
              <TableCell onClick={open}>
                <EnabledStatus enabled={schedule.active} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: "#28BF5C",
  RUNNING: "#3B82F6",
  FAILED: "#E11D48",
  CANCELED: "#878C99",
};

function ActivityChart({ activity }: { activity: TaskActivity }) {
  const chartConfig: ChartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const status of activity.statuses) {
      cfg[status] = {
        label: status.charAt(0) + status.slice(1).toLowerCase(),
        color: STATUS_COLOR[status] ?? "#9CA3AF",
      };
    }
    return cfg;
  }, [activity.statuses]);

  const { xAxisFormatter, xAxisTicks } = useMemo(() => {
    const data = activity.data;
    const range = data.length >= 2 ? data[data.length - 1].bucket - data[0].bucket : 0;
    const oneDay = 24 * 60 * 60 * 1000;
    const showTime = range <= oneDay;

    const formatter = (value: number) => {
      const date = new Date(value);
      return showTime
        ? date.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "UTC",
          })
        : date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          });
    };

    const ticks = showTime
      ? undefined
      : data.filter((d) => new Date(d.bucket).getUTCHours() === 0).map((d) => d.bucket);

    return { xAxisFormatter: formatter, xAxisTicks: ticks };
  }, [activity.data]);

  const tooltipLabelFormatter = useMemo(() => {
    const data = activity.data;
    const bucketMs = data.length >= 2 ? data[1].bucket - data[0].bucket : 0;
    const oneDay = 24 * 60 * 60 * 1000;
    const isSubDayBucket = bucketMs > 0 && bucketMs < oneDay;

    return (_label: string, payload: { payload?: { bucket?: number } }[]) => {
      const ts = payload?.[0]?.payload?.bucket;
      if (typeof ts !== "number" || !Number.isFinite(ts)) return _label;
      const date = new Date(ts);
      return isSubDayBucket
        ? date.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "UTC",
          })
        : date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          });
    };
  }, [activity.data]);

  return (
    <Chart.Root
      config={chartConfig}
      data={activity.data}
      dataKey="bucket"
      series={activity.statuses}
      fillContainer
    >
      <Chart.Bar
        stackId="status"
        barRadius={0}
        xAxisProps={{
          tickFormatter: xAxisFormatter,
          ...(xAxisTicks ? { ticks: xAxisTicks, interval: 0 } : {}),
        }}
        tooltipLabelFormatter={tooltipLabelFormatter}
      />
    </Chart.Root>
  );
}

function ActivityChartSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 items-end gap-px rounded-sm">
      {Array.from({ length: 42 }).map((_, i) => (
        <div key={i} className="h-full flex-1 bg-charcoal-850" />
      ))}
    </div>
  );
}

function TableLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

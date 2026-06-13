import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { Suspense, useMemo } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import { TextLink } from "~/components/primitives/TextLink";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import {
  TaskDetailPresenter,
  type TaskActivity,
  type TaskDetail,
} from "~/presenters/v3/TaskDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3EnvironmentPath,
  v3QueuesPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const slug = (data as { task?: TaskDetail | null } | undefined)?.task?.slug;
  return [{ title: slug ? `${slug} | Tasks | Trigger.dev` : "Task | Trigger.dev" }];
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
  const versions = url.searchParams.getAll("versions").filter((v) => v.length > 0);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );

  const presenter = new TaskDetailPresenter($replica, clickhouse);
  const task = await presenter.findTask({
    environmentId: environment.id,
    environmentType: environment.type,
    taskSlug: taskParam,
    expectedTriggerSource: "STANDARD",
  });

  if (!task) throw new Response("Task not found", { status: 404 });

  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  const activity = presenter
    .getActivity({
      environmentId: environment.id,
      taskSlug: task.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] } satisfies TaskActivity));

  const runList = new NextRunListPresenter($replica, clickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [task.slug],
      versions: versions.length > 0 ? versions : undefined,
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
    runList,
  });
};

export default function Page() {
  const { task, activity, runList } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const tasksListingPath = v3EnvironmentPath(organization, project, environment);
  const testPath = v3TestTaskPath(organization, project, environment, {
    taskIdentifier: task.slug,
  });
  const queuesPath = v3QueuesPath(organization, project, environment);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          backButton={{ to: tasksListingPath, text: "Tasks" }}
          title={
            <span className="flex items-center gap-1">
              <TaskIcon className="size-4.5 text-tasks" />
              <span>{task.slug}</span>
            </span>
          }
        />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="task-main" min="300px">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              {/* Top bar — title on the left; TimeFilter + pagination on the right.
                  h-10 matches the right-hand sidebar header height. */}
              <div className="flex h-10 items-center border-b border-grid-dimmed bg-background-bright pl-3 pr-2">
                <Header2>Runs</Header2>
                <div className="ml-auto flex items-center gap-1.5">
                  <TimeFilter defaultPeriod="7d" labelName="Runs" />
                  <Suspense fallback={null}>
                    <TypedAwait resolve={runList} errorElement={null}>
                      {(list) => (list ? <ListPagination list={list} /> : null)}
                    </TypedAwait>
                  </Suspense>
                </div>
              </div>

              <ResizablePanelGroup orientation="vertical" className="max-h-full">
                {/* Activity chart */}
                <ResizablePanel id="task-activity" min="220px" default="320px">
                  <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background p-2">
                    <Card className="h-full overflow-hidden px-0 pb-2 pt-3">
                      <Card.Header>Runs by status</Card.Header>
                      <div className="min-h-0 flex-1 px-2">
                        <Suspense fallback={<ActivityChartSkeleton />}>
                          <TypedAwait resolve={activity} errorElement={<ActivityChartSkeleton />}>
                            {(result) => <ActivityChart activity={result} />}
                          </TypedAwait>
                        </Suspense>
                      </div>
                    </Card>
                  </div>
                </ResizablePanel>

                <ResizableHandle id="task-activity-handle" />

                {/* Runs table */}
                <ResizablePanel id="task-content" min="160px">
                  <div className="h-full overflow-hidden">
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
                                stickyHeader
                              />
                            </div>
                          ) : (
                            <TableLoading />
                          )
                        }
                      </TypedAwait>
                    </Suspense>
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </ResizablePanel>

          <ResizableHandle id="task-detail-handle" />
          <ResizablePanel id="task-detail" min="280px" default="380px" max="500px" isStaticAtRest>
            <TaskDetailSidebar task={task} testPath={testPath} queuesPath={queuesPath} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

function TaskDetailSidebar({
  task,
  testPath,
  queuesPath,
}: {
  task: TaskDetail;
  testPath: string;
  queuesPath: string;
}) {
  const showExportName = task.exportName && task.exportName !== task.slug;
  const retrySummary = formatRetrySummary(task.retry);

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center gap-2 border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="flex min-w-0 flex-1 items-center gap-1.5">
          <TaskIcon className="size-4.5 shrink-0 text-tasks" />
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
          Test task
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
          {showExportName ? (
            <Property.Item>
              <Property.Label>Export name</Property.Label>
              <Property.Value>
                <CopyableText value={task.exportName ?? ""} />
              </Property.Value>
            </Property.Item>
          ) : null}
          {task.description ? (
            <Property.Item>
              <Property.Label>Description</Property.Label>
              <Property.Value>
                <Paragraph variant="small">{task.description}</Paragraph>
              </Property.Value>
            </Property.Item>
          ) : null}
          <Property.Item>
            <Property.Label>Type</Property.Label>
            <Property.Value>
              <Paragraph variant="small">Standard task</Paragraph>
            </Property.Value>
          </Property.Item>
          {task.workerVersion ? (
            <Property.Item>
              <Property.Label>Version</Property.Label>
              <Property.Value>
                <Paragraph variant="small" className="font-mono">
                  {task.workerVersion}
                </Paragraph>
              </Property.Value>
            </Property.Item>
          ) : null}
          {task.queue ? (
            <Property.Item>
              <Property.Label>Queue</Property.Label>
              <Property.Value>
                <div className="flex flex-col gap-0.5">
                  <TextLink to={queuesPath}>{task.queue.name}</TextLink>
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Concurrency: {task.queue.concurrencyLimit ?? "Unlimited"}
                    {task.queue.paused ? " · Paused" : ""}
                  </Paragraph>
                </div>
              </Property.Value>
            </Property.Item>
          ) : null}
          <Property.Item>
            <Property.Label>Machine</Property.Label>
            <Property.Value className="-ml-0.5">
              <MachineLabelCombo preset={task.machinePreset} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Max duration</Property.Label>
            <Property.Value>
              <Paragraph variant="small">
                {task.maxDurationInSeconds
                  ? `${task.maxDurationInSeconds}s (${formatDurationMilliseconds(
                      task.maxDurationInSeconds * 1000,
                      { style: "short" }
                    )})`
                  : "–"}
              </Paragraph>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>TTL</Property.Label>
            <Property.Value>
              <Paragraph variant="small">{task.ttl ?? "–"}</Paragraph>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Retry</Property.Label>
            <Property.Value>
              <Paragraph variant="small">{retrySummary}</Paragraph>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Payload schema</Property.Label>
            <Property.Value>
              <Paragraph variant="small">{task.hasPayloadSchema ? "Yes" : "–"}</Paragraph>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={task.createdAt} />
            </Property.Value>
          </Property.Item>
        </Property.Table>
      </div>
    </div>
  );
}

function formatRetrySummary(retry: TaskDetail["retry"]): string {
  if (!retry || retry.maxAttempts === undefined) return "–";
  if (retry.maxAttempts <= 1) return "Disabled";
  return `${retry.maxAttempts} attempts`;
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

    // ClickHouse buckets are aligned to UTC, so we format and pick ticks in
    // UTC. Using local time here causes off-by-one day labels and a tick
    // filter that matches zero buckets in any timezone other than UTC.
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

    // For multi-day ranges with sub-day buckets, only label the midnight
    // bucket on each day so we don't get repeated date labels across the
    // multiple sub-day buckets within a single day.
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

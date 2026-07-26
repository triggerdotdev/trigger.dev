import { type MetaFunction, useLocation, useNavigation, useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { type MutableRefObject, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  TypedAwait,
  typeddefer,
  type UseDataFunctionReturn,
  useTypedLoaderData,
} from "remix-typedjson";
import { z } from "zod";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { statusColor } from "~/components/primitives/charts/statusColors";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PulsingDot } from "~/components/primitives/PulsingDot";
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
import { useSearchParams } from "~/hooks/useSearchParam";
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
import { parseFiniteInt } from "~/utils/searchParams";
import { useRunsLiveReload } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/useRunsLiveReload";

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
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
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
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      taskSlug: task.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies TaskActivity);

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
      includeHasAnyRuns: true,
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
  const zoomToTimeFilter = useZoomToTimeFilter();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const tasksListingPath = v3EnvironmentPath(organization, project, environment);
  const testPath = v3TestTaskPath(organization, project, environment, {
    taskIdentifier: task.slug,
  });
  const queuesPath = v3QueuesPath(organization, project, environment);

  // New-runs banner state is lifted here so the button can live in the top bar,
  // while the count/action originate from the live-reload hook inside the
  // deferred runs table below. Count drives visibility; the ref exposes the
  // click action (kept current by TaskRunsList each render).
  const [newRunsCount, setNewRunsCount] = useState(0);
  const showNewRunsRef = useRef<() => void>(() => {});

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
                  {newRunsCount > 0 ? (
                    <NewRunsButton count={newRunsCount} onClick={() => showNewRunsRef.current()} />
                  ) : null}
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
                    <ChartSyncProvider onZoom={zoomToTimeFilter}>
                      <ChartCard title="Runs by status">
                        <Suspense fallback={<ActivityChartSkeleton />}>
                          <TypedAwait resolve={activity} errorElement={<ActivityChartSkeleton />}>
                            {(result) => <ActivityChart activity={result} />}
                          </TypedAwait>
                        </Suspense>
                      </ChartCard>
                    </ChartSyncProvider>
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
                            <TaskRunsList
                              list={list}
                              taskSlug={task.slug}
                              onNewRunsCountChange={setNewRunsCount}
                              showNewRunsRef={showNewRunsRef}
                            />
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

type TaskRunList = NonNullable<Awaited<UseDataFunctionReturn<typeof loader>["runList"]>>;

/**
 * Compact "N new runs" button, shown in the page top bar to the left of the
 * time filter when the live-reload hook has detected newer runs.
 */
function NewRunsButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <span className="flex duration-150 animate-in fade-in-0">
      <Button
        variant="secondary/small"
        className="text-text-bright"
        onClick={onClick}
        LeadingIcon={<PulsingDot className="h-2 w-2" />}
        tooltip="Refresh to see new runs"
        aria-label="New runs created. Refresh to see new runs."
      >
        {count >= 100 ? "99+ new runs" : `${count} new ${count === 1 ? "run" : "runs"}`}
      </Button>
    </span>
  );
}

/**
 * Runs table with live updating. Mirrors the Runs list page: active rows are
 * patched in place (status/timing/cost). The "N new runs" count is surfaced to
 * the top-bar button via `onNewRunsCountChange` (count → visibility) and
 * `showNewRunsRef` (the latest click action), since the button lives outside
 * this deferred boundary. The task lives in the route path rather than a
 * `tasks` filter, so we pass `taskSlug` to scope new-run detection to this task.
 */
function TaskRunsList({
  list,
  taskSlug,
  onNewRunsCountChange,
  showNewRunsRef,
}: {
  list: TaskRunList;
  taskSlug: string;
  onNewRunsCountChange: (count: number) => void;
  showNewRunsRef: MutableRefObject<() => void>;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const location = useLocation();
  const { has, replace } = useSearchParams();
  const revalidator = useRevalidator();

  // Loading a new version of this same page (time filter / pagination change).
  const isLoading =
    navigation.state === "loading" &&
    navigation.location !== undefined &&
    navigation.location.pathname === location.pathname &&
    navigation.location.search !== location.search;

  const { visibleRuns, newRunsCount, dismissNewRuns, childrenStatusesBasePath } = useRunsLiveReload({
    runs: list.runs,
    hasAnyRuns: list.hasAnyRuns,
    isLoading,
    organizationSlug: organization.slug,
    projectSlug: project.slug,
    environmentSlug: environment.slug,
    taskSlug,
  });

  const onClickShowNewRuns = () => {
    const isPaginated = has("cursor") || has("direction");
    dismissNewRuns();
    if (isPaginated) {
      replace({ cursor: undefined, direction: undefined });
      return;
    }
    revalidator.revalidate();
  };

  // Surface the banner to the top-bar button rendered by Page: keep the ref's
  // action current, mirror the count up, and clear it when this boundary
  // unmounts (e.g. the table re-suspends on a filter change).
  useEffect(() => {
    showNewRunsRef.current = onClickShowNewRuns;
  }, [onClickShowNewRuns, showNewRunsRef]);
  useEffect(() => {
    onNewRunsCountChange(newRunsCount);
  }, [newRunsCount, onNewRunsCountChange]);
  useEffect(() => () => onNewRunsCountChange(0), [onNewRunsCountChange]);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <TaskRunsTable
        total={visibleRuns.length}
        hasFilters={list.hasFilters}
        filters={list.filters}
        runs={visibleRuns}
        childrenStatusesBasePath={childrenStatusesBasePath}
        isLoading={isLoading}
        variant="dimmed"
        showTopBorder={false}
        stickyHeader
      />
    </div>
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
      <div className="flex min-w-0 items-center gap-2 border-b border-grid-dimmed py-2 pl-3 pr-2">
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
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
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

function ActivityChart({ activity }: { activity: TaskActivity }) {
  const chartConfig: ChartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const status of activity.statuses) {
      cfg[status] = {
        label: status.charAt(0) + status.slice(1).toLowerCase(),
        color: statusColor(status),
      };
    }
    return cfg;
  }, [activity.statuses]);

  const { tickFormatter, tooltipLabelFormatter } = useMemo(
    () => buildActivityTimeAxis(activity.data),
    [activity.data]
  );

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
        xAxisProps={{ tickFormatter }}
        tooltipLabelFormatter={tooltipLabelFormatter}
      />
    </Chart.Root>
  );
}

function ActivityChartSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 items-end gap-px rounded-sm">
      {Array.from({ length: 42 }).map((_, i) => (
        <div key={i} className="h-full flex-1 bg-background-dimmed" />
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

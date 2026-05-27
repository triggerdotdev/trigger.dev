import { BeakerIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import TooltipPortal from "~/components/primitives/TooltipPortal";
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
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUser } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3EnvironmentPath,
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

  const presenter = new TaskDetailPresenter($replica, clickhouseClient);
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

  const runList = new NextRunListPresenter($replica, clickhouseClient)
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

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          backButton={{ to: tasksListingPath, text: "Standard tasks" }}
          title={
            <span className="flex items-center gap-2">
              <TaskIcon className="size-4 text-tasks" />
              <span>{task.slug}</span>
            </span>
          }
        />
        <PageAccessories>
          <LinkButton variant="secondary/small" to={testPath} LeadingIcon={BeakerIcon}>
            Test standard task
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="task-main" min="300px">
            <div className="grid h-full grid-rows-[3rem_12rem_1fr] overflow-hidden">
              {/* Filter bar */}
              <div className="flex items-center gap-1.5 border-b border-grid-bright p-2">
                <TimeFilter defaultPeriod="7d" labelName="Runs" />
              </div>

              {/* Chart */}
              <div className="flex flex-col gap-3 overflow-hidden border-b border-grid-bright bg-background-bright py-2 pl-2 pr-4">
                <Suspense fallback={<ActivityChartSkeleton />}>
                  <TypedAwait resolve={activity} errorElement={<ActivityChartSkeleton />}>
                    {(result) =>
                      result.data.length > 0 && result.statuses.length > 0 ? (
                        <ActivityChart activity={result} />
                      ) : (
                        <ActivityChartEmpty />
                      )
                    }
                  </TypedAwait>
                </Suspense>
              </div>

              {/* Runs table */}
              <div className="flex flex-col gap-1 overflow-y-hidden">
                <div className="flex items-center justify-between pl-3 pr-2 pt-1">
                  <Header3 className="mb-1 mt-2">Runs</Header3>
                  <Suspense fallback={null}>
                    <TypedAwait resolve={runList}>
                      {(list) => (list ? <ListPagination list={list} /> : null)}
                    </TypedAwait>
                  </Suspense>
                </div>
                <Suspense fallback={<TableLoading />}>
                  <TypedAwait resolve={runList} errorElement={<TableLoading />}>
                    {(list) =>
                      list ? (
                        <TaskRunsTable
                          total={list.runs.length}
                          hasFilters={list.hasFilters}
                          filters={list.filters}
                          runs={list.runs}
                          variant="dimmed"
                        />
                      ) : (
                        <TableLoading />
                      )
                    }
                  </TypedAwait>
                </Suspense>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle id="task-detail-handle" />
          <ResizablePanel
            id="task-detail"
            min="280px"
            default="380px"
            max="500px"
            isStaticAtRest
          >
            <TaskDetailSidebar task={task} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

function TaskDetailSidebar({ task }: { task: TaskDetail }) {
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="border-b border-grid-dimmed px-3 py-2">
        <Header2 className="truncate">Task details</Header2>
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
              <span className="font-mono text-xs">{task.triggerSource}</span>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={task.createdAt} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Last seen</Property.Label>
            <Property.Value>
              <RelativeDateTime date={task.createdAt} />
            </Property.Value>
          </Property.Item>
        </Property.Table>
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: "#22c55e",
  RUNNING: "#3b82f6",
  FAILED: "#ef4444",
  CANCELED: "#878C99",
};

function ActivityChart({ activity }: { activity: TaskActivity }) {
  const data = activity.data;

  const xAxisFormatter = useMemo(() => {
    return (value: number) => {
      const date = new Date(value);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        hour12: false,
      });
    };
  }, []);

  const midnightTicks = useMemo(() => {
    const ticks: number[] = [];
    for (const d of data) {
      const date = new Date(d.bucket);
      if (date.getHours() === 0) ticks.push(d.bucket);
    }
    return ticks;
  }, [data]);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#272A2E" strokeDasharray="3 3" />
        <XAxis
          dataKey="bucket"
          tickFormatter={xAxisFormatter}
          ticks={midnightTicks}
          height={24}
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#878C99" }}
        />
        <YAxis
          width={30}
          tickMargin={4}
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#878C99" }}
          domain={["auto", (dataMax: number) => Math.max(1, dataMax * 1.15)]}
        />
        <Tooltip
          cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
          content={<ActivityTooltip />}
          allowEscapeViewBox={{ x: true, y: true }}
          wrapperStyle={{ zIndex: 1000 }}
          animationDuration={0}
        />
        {activity.statuses.map((status) => (
          <Bar
            key={status}
            dataKey={status}
            stackId="status"
            fill={STATUS_COLOR[status] ?? "#9CA3AF"}
            strokeWidth={0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

const ActivityTooltip = ({ active, payload }: TooltipProps<number, string>) => {
  if (!active || !payload?.length) return null;
  const timestamp = payload[0]?.payload?.bucket as number | undefined;
  if (!timestamp) return null;
  const date = new Date(timestamp);
  const formatted = date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-charcoal-650 pb-2">{formatted}</Header3>
        <div className="mt-2 flex flex-col gap-1">
          {payload.map((entry) => {
            const value = (entry.value as number) ?? 0;
            return (
              <div key={entry.dataKey} className="flex items-center gap-2 text-xs">
                <div className="size-2 rounded-[2px]" style={{ backgroundColor: entry.color }} />
                <span className="text-text-dimmed">{entry.dataKey}</span>
                <span className="tabular-nums text-text-bright">{value}</span>
              </div>
            );
          })}
        </div>
      </div>
    </TooltipPortal>
  );
};

function ActivityChartSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 items-end gap-px rounded-sm">
      {Array.from({ length: 42 }).map((_, i) => (
        <div key={i} className="h-full flex-1 bg-charcoal-850" />
      ))}
    </div>
  );
}

function ActivityChartEmpty() {
  return (
    <div className="flex h-full items-center justify-center">
      <Paragraph variant="small" className="text-text-dimmed">
        No runs in this time range.
      </Paragraph>
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

import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense, useMemo, useState } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { PageBody } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
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
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { SessionsTable } from "~/components/sessions/v1/SessionsTable";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  AgentDetailPresenter,
  type AgentActivity,
  type AgentDetail,
} from "~/presenters/v3/AgentDetailPresenter.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { SessionListPresenter } from "~/presenters/v3/SessionListPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3EnvironmentPath,
  v3PlaygroundAgentPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const slug = (data as { agent?: AgentDetail | null } | undefined)?.agent?.slug;
  return [{ title: slug ? `${slug} | Agents | Trigger.dev` : "Agent | Trigger.dev" }];
};

const AgentParamSchema = EnvironmentParamSchema.extend({
  agentParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam, agentParam } = AgentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

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

  const presenter = new AgentDetailPresenter($replica, clickhouse);
  const agent = await presenter.findAgent({
    environmentId: environment.id,
    environmentType: environment.type,
    agentSlug: agentParam,
  });

  if (!agent) {
    throw new Response("Agent not found", { status: 404 });
  }

  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  const activity = presenter
    .getActivity({
      environmentId: environment.id,
      agentSlug: agent.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] } satisfies AgentActivity));

  const runList = new NextRunListPresenter($replica, clickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [agent.slug],
      period,
      from,
      to,
      cursor,
      direction,
    })
    .catch(() => null);

  const sessionList = new SessionListPresenter($replica, clickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      taskIdentifiers: [agent.slug],
      period,
      from,
      to,
      cursor,
      direction,
    })
    .catch(() => null);

  return typeddefer({
    agent,
    activity,
    runList,
    sessionList,
  });
};

export default function Page() {
  const { agent, activity, runList, sessionList } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const playgroundPath = v3PlaygroundAgentPath(organization, project, environment, agent.slug);
  const tasksPath = v3EnvironmentPath(organization, project, environment);

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: tasksPath, text: "Agent tasks" }}
          title={
            <span className="flex items-center gap-1">
              <CubeSparkleIcon className="size-4 text-agents" />
              <span>{agent.slug}</span>
            </span>
          }
        />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="agent-main" min="300px">
            <ResizablePanelGroup orientation="vertical" className="max-h-full">
              {/* Activity chart + filters */}
              <ResizablePanel id="agent-activity" min="144px" default="200px">
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

              <ResizableHandle id="agent-activity-handle" />

              {/* Runs / Sessions tabs */}
              <ResizablePanel id="agent-content" min="160px">
                <AgentContentTabs sessionList={sessionList} runList={runList} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>

          <ResizableHandle id="agent-detail-handle" />
          <ResizablePanel id="agent-detail" min="280px" default="380px" max="500px" isStaticAtRest>
            <AgentDetailSidebar agent={agent} playgroundPath={playgroundPath} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </>
  );
}

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;

function AgentContentTabs({ sessionList, runList }: Pick<LoaderData, "sessionList" | "runList">) {
  const [tab, setTab] = useState<"sessions" | "runs">("sessions");

  return (
    <div className="grid h-full grid-rows-[2.25rem_1fr] overflow-hidden">
      {/* Tab bar + pagination on the same row */}
      <div className="flex items-center justify-between border-b border-grid-dimmed bg-background-bright pl-3 pr-1">
        <TabContainer className="-mb-px translate-y-[2px]">
          <TabButton
            isActive={tab === "sessions"}
            layoutId="agent-content-tabs"
            onClick={() => setTab("sessions")}
          >
            Sessions
          </TabButton>
          <TabButton
            isActive={tab === "runs"}
            layoutId="agent-content-tabs"
            onClick={() => setTab("runs")}
          >
            Runs
          </TabButton>
        </TabContainer>
        {tab === "sessions" ? (
          <Suspense fallback={null}>
            <TypedAwait resolve={sessionList} errorElement={null}>
              {(list) => (list ? <ListPagination list={list} /> : null)}
            </TypedAwait>
          </Suspense>
        ) : (
          <Suspense fallback={null}>
            <TypedAwait resolve={runList} errorElement={null}>
              {(list) => (list ? <ListPagination list={list} /> : null)}
            </TypedAwait>
          </Suspense>
        )}
      </div>

      {/* Tab content */}
      <div className="min-h-0 overflow-hidden">
        {tab === "sessions" ? (
          <Suspense fallback={<TableLoading />}>
            <TypedAwait resolve={sessionList} errorElement={<TableLoading />}>
              {(list) =>
                list ? (
                  <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                    <SessionsTable
                      sessions={list.sessions}
                      filters={list.filters}
                      hasFilters={list.hasFilters}
                      showTopBorder={false}
                    />
                  </div>
                ) : (
                  <TableLoading />
                )
              }
            </TypedAwait>
          </Suspense>
        ) : (
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
        )}
      </div>
    </div>
  );
}

function AgentDetailSidebar({
  agent,
  playgroundPath,
}: {
  agent: AgentDetail;
  playgroundPath: string;
}) {
  const config = (agent.config ?? {}) as Record<string, unknown>;
  const agentType = typeof config.type === "string" ? config.type : undefined;
  const model = typeof config.model === "string" ? config.model : undefined;
  const instructions = typeof config.instructions === "string" ? config.instructions : undefined;

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="border-b border-grid-dimmed px-3 py-2">
        <Header2 className="flex min-w-0 items-center gap-1.5">
          <CubeSparkleIcon className="size-4 shrink-0 text-agents" />
          <span className="truncate">{agent.slug}</span>
        </Header2>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Property.Table>
          <Property.Item>
            <Property.Label>Test this agent</Property.Label>
            <Property.Value className="mt-1">
              <LinkButton
                variant="primary/small"
                to={playgroundPath}
                LeadingIcon={BeakerIcon}
                iconSpacing="gap-x-2"
                leadingIconClassName="-mx-2"
              >
                Test
              </LinkButton>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Slug</Property.Label>
            <Property.Value>
              <CopyableText value={agent.slug} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>File path</Property.Label>
            <Property.Value>
              <CopyableText value={agent.filePath} />
            </Property.Value>
          </Property.Item>
          {agentType && (
            <Property.Item>
              <Property.Label>Type</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">{agentType}</span>
              </Property.Value>
            </Property.Item>
          )}
          {model && (
            <Property.Item>
              <Property.Label>Model</Property.Label>
              <Property.Value>
                <span className="font-mono text-sm">{model}</span>
              </Property.Value>
            </Property.Item>
          )}
          {instructions && (
            <Property.Item className="gap-1">
              <Property.Label>Instructions</Property.Label>
              <Property.Value>
                <Paragraph variant="small" className="whitespace-pre-wrap text-text-dimmed">
                  {instructions}
                </Paragraph>
              </Property.Value>
            </Property.Item>
          )}
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={agent.createdAt} />
            </Property.Value>
          </Property.Item>
        </Property.Table>
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: "#28BF5C",
  RUNNING: "#3B82F6",
  FAILED: "#E11D48",
  CANCELED: "#878C99",
};

function ActivityChart({ activity }: { activity: AgentActivity }) {
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
    // bucket on each day so we don't get repeated "Jun 1" labels across the
    // multiple 6h buckets within a single day.
    const ticks = showTime
      ? undefined
      : data.filter((d) => new Date(d.bucket).getUTCHours() === 0).map((d) => d.bucket);

    return { xAxisFormatter: formatter, xAxisTicks: ticks };
  }, [activity.data]);

  const tooltipLabelFormatter = useMemo(() => {
    const data = activity.data;
    // Infer bucket size from the data so we can pick a sensible date format.
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
          // Explicit ticks (one per midnight) on multi-day ranges; recharts
          // auto-spaces when undefined (sub-day ranges).
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

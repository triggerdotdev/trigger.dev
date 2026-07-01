import { BookOpenIcon } from "@heroicons/react/24/solid";
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
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { statusColor } from "~/components/primitives/charts/statusColors";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { SessionsTable } from "~/components/sessions/v1/SessionsTable";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
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
  docsPath,
  EnvironmentParamSchema,
  v3EnvironmentPath,
  v3PlaygroundAgentPath,
} from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";

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
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
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

  const runActivity = presenter
    .getActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      agentSlug: agent.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies AgentActivity);

  const sessionActivity = presenter
    .getSessionActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      agentSlug: agent.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies AgentActivity);

  const llmCostActivity = presenter
    .getLlmCostActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      agentSlug: agent.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies AgentActivity);

  const llmTokenActivity = presenter
    .getLlmTokenActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      agentSlug: agent.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies AgentActivity);

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
    runActivity,
    sessionActivity,
    llmCostActivity,
    llmTokenActivity,
    runList,
    sessionList,
  });
};

type AgentTab = "sessions" | "runs";

export default function Page() {
  const {
    agent,
    runActivity,
    sessionActivity,
    llmCostActivity,
    llmTokenActivity,
    runList,
    sessionList,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const playgroundPath = v3PlaygroundAgentPath(organization, project, environment, agent.slug);
  const tasksPath = v3EnvironmentPath(organization, project, environment);

  const [tab, setTab] = useState<AgentTab>("sessions");
  const zoomToTimeFilter = useZoomToTimeFilter();
  const tabLabel = tab === "sessions" ? "Sessions" : "Runs";

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: tasksPath, text: "Tasks" }}
          title={
            <span className="flex items-center gap-1">
              <CubeSparkleIcon className="size-4.5 text-agents" />
              <span>{agent.slug}</span>
            </span>
          }
        />
        <PageAccessories>
          <LinkButton
            variant="docs/small"
            LeadingIcon={BookOpenIcon}
            to={docsPath("ai-chat/overview")}
          >
            Agents docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="agent-main" min="300px">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              {/* Top bar — tabs on the left; TimeFilter + pagination on the right.
                  h-10 matches the right-hand sidebar header height. */}
              <div className="flex h-10 items-end border-b border-grid-dimmed bg-background-bright pl-3 pr-2">
                <TabContainer className="-mb-px">
                  <TabButton
                    isActive={tab === "sessions"}
                    layoutId="agent-page-tabs"
                    onClick={() => setTab("sessions")}
                  >
                    Sessions
                  </TabButton>
                  <TabButton
                    isActive={tab === "runs"}
                    layoutId="agent-page-tabs"
                    onClick={() => setTab("runs")}
                  >
                    Runs
                  </TabButton>
                </TabContainer>
                <div className="ml-auto flex items-center gap-2 self-center">
                  <TimeFilter defaultPeriod="7d" labelName={tabLabel} />
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
              </div>

              <ResizablePanelGroup orientation="vertical" className="max-h-full">
                {/* Activity / LLM cost / Token charts */}
                <ResizablePanel id="agent-activity" min="220px" default="320px">
                  <div className="flex h-full flex-col overflow-hidden bg-background p-2">
                    <ChartSyncProvider onZoom={zoomToTimeFilter}>
                      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
                        <ChartCard title={tabLabel}>
                          {tab === "sessions" ? (
                            <Suspense fallback={<ActivityChartSkeleton />}>
                              <TypedAwait
                                resolve={sessionActivity}
                                errorElement={<ActivityChartSkeleton />}
                              >
                                {(result) => <ActivityChart activity={result} />}
                              </TypedAwait>
                            </Suspense>
                          ) : (
                            <Suspense fallback={<ActivityChartSkeleton />}>
                              <TypedAwait
                                resolve={runActivity}
                                errorElement={<ActivityChartSkeleton />}
                              >
                                {(result) => <ActivityChart activity={result} />}
                              </TypedAwait>
                            </Suspense>
                          )}
                        </ChartCard>

                        <ChartCard title="LLM spend ($)">
                          <Suspense fallback={<ActivityChartSkeleton />}>
                            <TypedAwait
                              resolve={llmCostActivity}
                              errorElement={<ActivityChartSkeleton />}
                            >
                              {(result) => (
                                <ScalarActivityChart
                                  activity={result}
                                  seriesKey="cost"
                                  label="Spend"
                                  color="#A855F7"
                                  valueFormatter={formatCurrency}
                                />
                              )}
                            </TypedAwait>
                          </Suspense>
                        </ChartCard>

                        <ChartCard title="Tokens">
                          <Suspense fallback={<ActivityChartSkeleton />}>
                            <TypedAwait
                              resolve={llmTokenActivity}
                              errorElement={<ActivityChartSkeleton />}
                            >
                              {(result) => (
                                <ScalarActivityChart
                                  activity={result}
                                  seriesKey="tokens"
                                  label="Tokens"
                                  color="#14B8A6"
                                  valueFormatter={formatTokens}
                                />
                              )}
                            </TypedAwait>
                          </Suspense>
                        </ChartCard>
                      </div>
                    </ChartSyncProvider>
                  </div>
                </ResizablePanel>

                <ResizableHandle id="agent-activity-handle" />

                {/* Table */}
                <ResizablePanel id="agent-content" min="160px">
                  <AgentContentArea tab={tab} sessionList={sessionList} runList={runList} />
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
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

function AgentContentArea({
  tab,
  sessionList,
  runList,
}: { tab: AgentTab } & Pick<LoaderData, "sessionList" | "runList">) {
  return (
    <div className="h-full overflow-hidden">
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
                    stickyHeader
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
                    stickyHeader
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
      <div className="flex items-center gap-2 border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="flex min-w-0 flex-1 items-center gap-1.5">
          <CubeSparkleIcon className="size-4.5 shrink-0 text-agents" />
          <span className="truncate">{agent.slug}</span>
        </Header2>
        <LinkButton
          variant="primary/small"
          to={playgroundPath}
          LeadingIcon={BeakerIcon}
          iconSpacing="gap-x-2"
          leadingIconClassName="-mx-2"
          className="shrink-0"
        >
          Test agent
        </LinkButton>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Property.Table>
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

function ActivityChart({ activity }: { activity: AgentActivity }) {
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

function ScalarActivityChart({
  activity,
  seriesKey,
  label,
  color,
  valueFormatter,
}: {
  activity: AgentActivity;
  seriesKey: string;
  label: string;
  color: string;
  valueFormatter: (value: number) => string;
}) {
  const chartConfig: ChartConfig = useMemo(
    () => ({ [seriesKey]: { label, color } }),
    [seriesKey, label, color]
  );

  const { tickFormatter, tooltipLabelFormatter } = useMemo(
    () => buildActivityTimeAxis(activity.data),
    [activity.data]
  );

  return (
    <Chart.Root config={chartConfig} data={activity.data} dataKey="bucket" fillContainer>
      <Chart.Bar
        barRadius={0}
        xAxisProps={{ tickFormatter }}
        tooltipLabelFormatter={tooltipLabelFormatter}
        tooltipValueFormatter={valueFormatter}
      />
    </Chart.Root>
  );
}

function formatCurrency(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value < 1000) return value.toLocaleString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

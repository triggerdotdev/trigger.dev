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
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { PlaygroundIcon } from "~/assets/icons/PlaygroundIcon";
import { PageBody } from "~/components/layout/AppLayout";
import { ListPagination, DirectionSchema } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import * as Property from "~/components/primitives/PropertyTable";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Spinner } from "~/components/primitives/Spinner";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
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
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUser } from "~/services/session.server";
import {
  EnvironmentParamSchema,
  v3AgentsPath,
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

  const presenter = new AgentDetailPresenter($replica, clickhouseClient);
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

  const runList = new NextRunListPresenter($replica, clickhouseClient)
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

  const sessionList = new SessionListPresenter($replica, clickhouseClient)
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
  const agentsPath = v3AgentsPath(organization, project, environment);

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: agentsPath, text: "Agent tasks" }}
          title={
            <span className="flex items-center gap-2">
              <CubeSparkleIcon className="size-4 text-agents" />
              <span>{agent.slug}</span>
            </span>
          }
        />
        <PageAccessories>
          <LinkButton variant="secondary/small" to={playgroundPath} LeadingIcon={PlaygroundIcon}>
            Test agent task
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="agent-main" min="300px">
            <div className="grid h-full grid-rows-[12rem_1fr] overflow-hidden">
              {/* Activity chart + filters */}
              <div className="flex flex-col gap-3 overflow-hidden border-b border-grid-bright bg-background-bright py-2 pl-2 pr-4">
                <div className="flex items-center gap-2">
                  <TimeFilter defaultPeriod="7d" labelName="Runs" />
                </div>
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

              {/* Runs / Sessions tabs */}
              <ClientTabs defaultValue="sessions" className="flex flex-col overflow-hidden">
                <ClientTabsList className="border-b border-grid-dimmed px-3">
                  <ClientTabsTrigger value="sessions">Sessions</ClientTabsTrigger>
                  <ClientTabsTrigger value="runs">Runs</ClientTabsTrigger>
                </ClientTabsList>
                <ClientTabsContent value="sessions" className="flex-1 overflow-hidden">
                  <Suspense fallback={<TableLoading />}>
                    <TypedAwait resolve={sessionList} errorElement={<TableLoading />}>
                      {(list) =>
                        list ? (
                          <div className="flex h-full flex-col gap-1 overflow-hidden">
                            <div className="flex items-center justify-end px-3 pt-2">
                              <ListPagination list={list} />
                            </div>
                            <div className="flex-1 overflow-y-auto">
                              <SessionsTable
                                sessions={list.sessions}
                                filters={list.filters}
                                hasFilters={list.hasFilters}
                              />
                            </div>
                          </div>
                        ) : (
                          <TableLoading />
                        )
                      }
                    </TypedAwait>
                  </Suspense>
                </ClientTabsContent>
                <ClientTabsContent value="runs" className="flex-1 overflow-hidden">
                  <Suspense fallback={<TableLoading />}>
                    <TypedAwait resolve={runList} errorElement={<TableLoading />}>
                      {(list) =>
                        list ? (
                          <div className="flex h-full flex-col gap-1 overflow-hidden">
                            <div className="flex items-center justify-end px-3 pt-2">
                              <ListPagination list={list} />
                            </div>
                            <div className="flex-1 overflow-y-auto">
                              <TaskRunsTable
                                total={list.runs.length}
                                hasFilters={list.hasFilters}
                                filters={list.filters}
                                runs={list.runs}
                                variant="dimmed"
                              />
                            </div>
                          </div>
                        ) : (
                          <TableLoading />
                        )
                      }
                    </TypedAwait>
                  </Suspense>
                </ClientTabsContent>
              </ClientTabs>
            </div>
          </ResizablePanel>

          <ResizableHandle id="agent-detail-handle" />
          <ResizablePanel
            id="agent-detail"
            min="280px"
            default="380px"
            max="500px"
            isStaticAtRest
          >
            <AgentDetailSidebar agent={agent} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </>
  );
}

function AgentDetailSidebar({ agent }: { agent: AgentDetail }) {
  const config = (agent.config ?? {}) as Record<string, unknown>;
  const agentType =
    typeof config.type === "string" ? config.type : undefined;
  const model = typeof config.model === "string" ? config.model : undefined;
  const instructions =
    typeof config.instructions === "string" ? config.instructions : undefined;

  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="border-b border-grid-dimmed px-3 py-2">
        <Header2 className="truncate">Agent details</Header2>
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
                <span className="font-mono text-xs">{agentType}</span>
              </Property.Value>
            </Property.Item>
          )}
          {model && (
            <Property.Item>
              <Property.Label>Model</Property.Label>
              <Property.Value>
                <span className="font-mono text-xs">{model}</span>
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
          <Property.Item>
            <Property.Label>Last seen</Property.Label>
            <Property.Value>
              <RelativeDateTime date={agent.createdAt} />
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

function ActivityChart({ activity }: { activity: AgentActivity }) {
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

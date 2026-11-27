import { type ShouldRevalidateFunction, useLocation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { DocsHeaderButton } from "~/components/DocsPanel";
import { agentsAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { ChartBlankState } from "~/components/primitives/charts/ChartBlankState";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { statusColor } from "~/components/primitives/charts/statusColors";
import { DeferredContent } from "~/components/primitives/detail/DeferredContent";
import {
  DetailPageTitle,
  DetailProperty,
  PropertyGroup,
  useDetailTab,
} from "~/components/primitives/detail/DetailPage";
import {
  ChartSkeleton,
  DetailTabEmpty,
  DetailTabError,
  DetailTabLoading,
  DetailTableTab,
  SkeletonBone,
} from "~/components/primitives/detail/DetailSections";
import { NavBar, PageAccessories } from "~/components/primitives/PageHeader";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { SessionsTable } from "~/components/sessions/v1/SessionsTable";
import { TaskDetailView } from "~/components/tasks/TaskDetailView";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
import {
  type AgentActivity,
  AgentDetailPresenter,
  type AgentModelUsage,
} from "~/presenters/v3/AgentDetailPresenter.server";
import { SessionListPresenter } from "~/presenters/v3/SessionListPresenter.server";
import { loadTaskDetailPage, taskQueueAction } from "~/presenters/v3/TaskDetailPage.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { cn } from "~/utils/cn";
import { onlyDetailTabChanged } from "~/utils/detailTabRevalidation";
import type { Handle } from "~/utils/handle";
import { formatNumber } from "~/utils/numberFormatter";
import { pageMeta } from "~/utils/pageTitle";
import { v3EnvironmentPath, v3PlaygroundAgentPath, v3SessionsPath } from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";

export const handle: Handle = {
  agentPageContext: (data) => agentsAgentPageContext(data),
};

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.task?.slug ?? params.agentParam ?? "Agent",
  "Agents",
]);

const EMPTY_ACTIVITY: AgentActivity = { data: [], statuses: [] };

/**
 * The agent page is the task page (Runs, Queue, the rail) with the agent's Sessions tab first,
 * the Playground as its main action, and the agent's model and instructions in the rail.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user, project, environment, time, page } = await loadTaskDetailPage({
    request,
    params: { ...(params as Record<string, string>), taskParam: params.agentParam },
    triggerSource: "AGENT",
    defaultTab: "sessions",
  });

  const url = new URL(request.url);
  const sessionsTabOpen = (url.searchParams.get("tab") ?? "sessions") === "sessions";
  const period = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const cursor = sessionsTabOpen ? (url.searchParams.get("cursor") ?? undefined) : undefined;
  const direction = DirectionSchema.catch("forward").parse(
    url.searchParams.get("direction") ?? undefined
  );

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const presenter = new AgentDetailPresenter(clickhouse);
  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    agentSlug: page.task.slug,
    from: time.from,
    to: time.to,
  };

  const config = (page.task.config ?? {}) as Record<string, unknown>;

  return typeddefer({
    ...page,
    // The dashboard agent's page context reads `agent.slug`.
    agent: {
      slug: page.task.slug,
      type: typeof config.type === "string" ? config.type : null,
      model: typeof config.model === "string" ? config.model : null,
      instructions: typeof config.instructions === "string" ? config.instructions : null,
    },
    sessionActivity: presenter.getSessionActivity(scope).catch(() => EMPTY_ACTIVITY),
    llmCostActivity: presenter.getLlmCostActivity(scope).catch(() => EMPTY_ACTIVITY),
    llmTokenActivity: presenter.getLlmTokenActivity(scope).catch(() => EMPTY_ACTIVITY),
    modelUsage: presenter.getModelUsage(scope).catch((): AgentModelUsage[] => []),
    sessionList: new SessionListPresenter($replica, clickhouse)
      .call(project.organizationId, environment.id, {
        userId: user.id,
        projectId: project.id,
        taskIdentifiers: [page.task.slug],
        period,
        from,
        to,
        cursor,
        direction,
      })
      .catch(() => null),
  });
};

/** The Queue tab's pause, resume and override buttons post here. */
export const action = taskQueueAction;

/** Every tab's data is already loaded: switching tabs doesn't run the loader again. */
export const shouldRevalidate: ShouldRevalidateFunction = (args) =>
  onlyDetailTabChanged(args) ? false : args.defaultShouldRevalidate;

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { agent } = data;

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={agent.slug}
          backButton={{ to: v3EnvironmentPath(organization, project, environment), text: "Tasks" }}
        />
        <PageAccessories>
          <WhenAgentUnavailable>
            <DocsHeaderButton path="ai-chat/overview">Agents docs</DocsHeaderButton>
          </WhenAgentUnavailable>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <TaskDetailView
          data={data}
          leadingTab={{
            id: "sessions",
            label: "Sessions",
            content: <AgentSessionsTab data={data} />,
          }}
          primaryAction={
            <LinkButton
              variant="primary/small"
              to={v3PlaygroundAgentPath(organization, project, environment, agent.slug)}
              LeadingIcon={BeakerIcon}
              iconSpacing="gap-x-2"
              leadingIconClassName="-mx-2"
            >
              Playground
            </LinkButton>
          }
          detailsExtra={<AgentDetailsProperties data={data} />}
          railAfterDetails={
            agent.instructions ? (
              <PropertyGroup title="Instructions">
                <Instructions text={agent.instructions} />
              </PropertyGroup>
            ) : null
          }
        />
      </PageBody>
    </PageContainer>
  );
}

// ---------- Sessions ----------

/** The page's tabs, in order; the first opens by default. */
const AGENT_TABS = ["sessions", "runs", "queue"] as const;

const SESSION_SKELETON_COLUMNS = [
  { label: "ID" },
  { label: "Status" },
  { label: "Type" },
  { label: "Agent ID" },
  { label: "Test" },
  { label: "Tags" },
  { label: "Created" },
  { label: "Duration" },
];

function AgentSessionsTab({ data }: { data: LoaderData }) {
  const [, , isPending] = useDetailTab(AGENT_TABS);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();

  const params = new URLSearchParams(location.search);
  const sessionsListPath = `${v3SessionsPath(organization, project, environment)}?${new URLSearchParams(
    [
      ["taskIdentifiers", data.agent.slug],
      ...(["period", "from", "to"] as const).flatMap((key) => {
        const value = params.get(key);
        return value ? [[key, value]] : [];
      }),
    ]
  ).toString()}`;
  params.delete("tab");
  const retainKey = params.toString();

  const tools = <TimeFilter defaultPeriod="7d" labelName="Sessions" />;
  const openInSessionsList = (
    <LinkButton
      variant="tertiary/small"
      to={sessionsListPath}
      LeadingIcon={AIChatIcon}
      leadingIconClassName="text-sessions"
    >
      Open in sessions list
    </LinkButton>
  );
  const band = <SessionsBand data={data} retainKey={retainKey} />;
  const skeleton = (
    <DetailTableTab tools={tools} actions={openInSessionsList} above={band}>
      <DetailTabLoading columns={SESSION_SKELETON_COLUMNS} rows={10} />
    </DetailTableTab>
  );

  if (isPending) return skeleton;

  return (
    <DeferredContent
      resolve={data.sessionList}
      retainKey={retainKey}
      fallback={skeleton}
      errorElement={
        <DetailTableTab tools={tools} actions={openInSessionsList} above={band}>
          <DetailTabError
            title="Couldn't load sessions"
            cause="The sessions for this agent didn't load. Try again, or open them in the sessions list."
          />
        </DetailTableTab>
      }
    >
      {(list) =>
        !list ? (
          skeleton
        ) : (
          <DetailTableTab
            tools={tools}
            actions={
              <>
                {openInSessionsList}
                <ListPagination list={list} />
              </>
            }
            above={band}
          >
            {list.sessions.length === 0 && !params.has("cursor") ? (
              <DetailTabEmpty
                title="No sessions in this period"
                description="Start a conversation in the Playground, or widen the time filter."
                action={
                  <LinkButton
                    variant="secondary/small"
                    to={v3PlaygroundAgentPath(organization, project, environment, data.agent.slug)}
                    LeadingIcon={BeakerIcon}
                    iconSpacing="gap-x-2"
                    leadingIconClassName="-mx-2"
                  >
                    Open Playground
                  </LinkButton>
                }
              />
            ) : (
              <SessionsTable
                sessions={list.sessions}
                filters={list.filters}
                hasFilters={list.hasFilters}
                showTopBorder={false}
                stickyHeader
              />
            )}
          </DetailTableTab>
        )
      }
    </DeferredContent>
  );
}

/**
 * Sessions by status beside what they cost: LLM spend and tokens for the same period, each with
 * its total. Drag across any chart to zoom the time filter.
 */
function SessionsBand({ data, retainKey }: { data: LoaderData; retainKey: string }) {
  const zoomToTimeFilter = useZoomToTimeFilter();

  return (
    <div className="grid h-40 flex-none grid-cols-3 border-b border-grid-bright">
      <ChartSyncProvider onZoom={zoomToTimeFilter}>
        <BandPanel
          label="Sessions"
          resolve={data.sessionActivity}
          retainKey={retainKey}
          total={(activity) => formatNumber(sumActivity(activity))}
        >
          {(activity) =>
            sumActivity(activity) > 0 ? (
              <SessionsByStatusChart activity={activity} />
            ) : (
              <ChartBlankState icon={AIChatIcon} message="No sessions in this period" />
            )
          }
        </BandPanel>
        <BandPanel
          label="LLM spend"
          resolve={data.llmCostActivity}
          retainKey={retainKey}
          total={(activity) => formatCurrency(sumActivity(activity))}
          className="border-l border-grid-bright"
        >
          {(activity) =>
            sumActivity(activity) > 0 ? (
              <ScalarActivityChart
                activity={activity}
                seriesKey="cost"
                label="Spend"
                color="var(--color-agents)"
                valueFormatter={formatCurrency}
              />
            ) : (
              <ChartBlankState message="No LLM calls recorded" />
            )
          }
        </BandPanel>
        <BandPanel
          label="Tokens"
          resolve={data.llmTokenActivity}
          retainKey={retainKey}
          total={(activity) => formatTokens(sumActivity(activity))}
          className="border-l border-grid-bright"
        >
          {(activity) =>
            sumActivity(activity) > 0 ? (
              <ScalarActivityChart
                activity={activity}
                seriesKey="tokens"
                label="Tokens"
                color="#14B8A6"
                valueFormatter={formatTokens}
              />
            ) : (
              <ChartBlankState message="No LLM calls recorded" />
            )
          }
        </BandPanel>
      </ChartSyncProvider>
    </div>
  );
}

function BandPanel({
  label,
  resolve,
  retainKey,
  total,
  className,
  children,
}: {
  label: string;
  resolve: Promise<AgentActivity>;
  retainKey: string;
  total: (activity: AgentActivity) => string;
  className?: string;
  children: (activity: AgentActivity) => React.ReactNode;
}) {
  const loading = (
    <>
      <div className="flex h-5 items-baseline gap-2">
        <span className="text-xs text-text-dimmed">{label}</span>
        <SkeletonBone className="h-3 w-10" />
      </div>
      <div className="min-h-0 flex-1">
        <ChartSkeleton bars={label === "Sessions" ? 42 : 20} />
      </div>
    </>
  );

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 px-3 pb-2 pt-2.5", className)}>
      <DeferredContent
        resolve={resolve}
        retainKey={retainKey}
        fallback={loading}
        errorElement={loading}
      >
        {(activity) => (
          <>
            <div className="flex h-5 items-baseline gap-2">
              <span className="text-xs text-text-dimmed">{label}</span>
              <span className="text-sm font-medium tabular-nums text-text-bright">
                {total(activity)}
              </span>
            </div>
            <div className="min-h-0 flex-1">{children(activity)}</div>
          </>
        )}
      </DeferredContent>
    </div>
  );
}

function sumActivity(activity: AgentActivity) {
  let total = 0;
  for (const point of activity.data) {
    for (const key of activity.statuses) total += Number(point[key] ?? 0);
  }
  return total;
}

function SessionsByStatusChart({ activity }: { activity: AgentActivity }) {
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

// ---------- Rail ----------

function AgentDetailsProperties({ data }: { data: LoaderData }) {
  const { agent } = data;
  return (
    <>
      {agent.type ? (
        <DetailProperty label="Agent type">
          <span className="font-mono text-xs">{agent.type}</span>
        </DetailProperty>
      ) : null}
      <DetailProperty label="Model">
        {agent.model ? (
          <span className="font-mono text-xs">{agent.model}</span>
        ) : (
          <DeferredContent
            resolve={data.modelUsage}
            fallback={<SkeletonBone className="h-3.5 w-24" />}
            errorElement={<>–</>}
          >
            {(usage) => <ModelUsage usage={usage} />}
          </DeferredContent>
        )}
      </DetailProperty>
    </>
  );
}

/** The models the agent called in the period, with how many calls each. */
function ModelUsage({ usage }: { usage: AgentModelUsage[] }) {
  if (usage.length === 0) {
    return <span className="text-text-dimmed">No LLM calls in this period</span>;
  }
  return (
    <ul className="flex min-w-0 flex-col gap-1">
      {usage.map((row) => (
        <li key={row.model} className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="truncate font-mono text-xs">{row.model}</span>
          <span className="flex-none text-xs tabular-nums text-text-dimmed">
            {formatNumber(row.calls)} {row.calls === 1 ? "call" : "calls"}
          </span>
        </li>
      ))}
    </ul>
  );
}

const INSTRUCTIONS_PREVIEW_CHARS = 320;

function Instructions({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > INSTRUCTIONS_PREVIEW_CHARS;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <p
        className={cn(
          "whitespace-pre-wrap text-xs leading-5 text-text-dimmed",
          long && !expanded && "line-clamp-6"
        )}
      >
        {text}
      </p>
      {long ? (
        <Button variant="minimal/small" onClick={() => setExpanded((open) => !open)}>
          {expanded ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
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

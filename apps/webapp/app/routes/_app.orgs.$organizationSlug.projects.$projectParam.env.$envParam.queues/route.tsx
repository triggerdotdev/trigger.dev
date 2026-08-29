import {
  ArrowUpCircleIcon,
  BookOpenIcon,
  ExclamationTriangleIcon,
  PauseIcon,
  PlayIcon,
  RectangleStackIcon,
} from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { QueuesIcon } from "~/assets/icons/QueuesIcon";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  InfoIconTooltip,
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { TasksIcon } from "~/assets/icons/TasksIcon";
import { QueueName } from "~/components/runs/v3/QueueName";
import { env } from "~/env.server";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { EnvironmentQueuePresenter } from "~/presenters/v3/EnvironmentQueuePresenter.server";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import {
  QueueMetricsPresenter,
  type QueueListMetric,
} from "~/presenters/v3/QueueMetricsPresenter.server";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { parseFiniteInt } from "~/utils/searchParams";
import { MiniLineChart } from "~/components/metrics/MiniLineChart";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
import {
  useIsMetricResponseFresh,
  useMetricResourceQuery,
  type MetricResourceTimeRange,
} from "~/hooks/useMetricResourceQuery";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT } from "~/utils/environmentPauseSource";
import {
  concurrencyPath,
  docsPath,
  EnvironmentParamSchema,
  v3BillingPath,
  v3QueuePath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import type { Handle } from "~/utils/handle";
import { queuesAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { WhenAgentUnavailable } from "~/components/dashboard-agent/WhenAgentUnavailable";
import { PauseEnvironmentService } from "~/v3/services/pauseEnvironment.server";
import { handleQueueMutationAction } from "~/models/queueMutation.server";
import {
  QueueOverrideConcurrencyButton,
  QueuePauseResumeButton,
} from "~/components/queues/QueueControls";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { BigNumber } from "~/components/metrics/BigNumber";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { QueueAllocationPresenter } from "~/presenters/v3/QueueAllocationPresenter.server";
import {
  QUEUE_METRICS_DEFAULT_PERIOD,
  QUEUE_METRICS_RETENTION_DAYS,
  clampQueueMetricsPeriod,
  clipQueueMetricsWindow,
  queueMetricsPeriodFromRequest,
  resolveQueueMetricsPeriod,
  useRememberQueueMetricsPeriod,
} from "~/components/queues/queueMetricsPeriod";
import { queueMetricsMaxPeriodDays } from "~/components/queues/queueMetricsPeriod.server";
import { isQueueAtCapacity } from "~/components/queues/queue-thresholds";
import { pageMeta } from "~/utils/pageTitle";

const SearchParamsSchema = z.object({
  query: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  period: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  sort: z.enum(["busiest", "queued", "name"]).optional(),
});

// The live "Queued" / "Running" header blocks poll ClickHouse on a short cadence so they stay
// current after first paint. They read the env-wide gauges from env_metrics (the env-level rollup
// of queue_metrics, cheapest for a dimension-free query), always over a fixed 15m window regardless
// of the chart/table period, and are NOT scoped to the visible queue set (the blocks are env-wide).
const QUEUE_LIVE_BLOCKS_PERIOD = "15m";
const QUEUE_LIVE_BLOCKS_QUERY =
  "SELECT timeBucket() AS t, max(max_env_queued) AS env_queued, max(max_env_running) AS env_running FROM env_metrics GROUP BY t ORDER BY t";
// Trust the ClickHouse gauge only while its newest bucket is this recent; otherwise fall back to
// the loader's Redis-exact live values (matches LIVE_GAUGE_FRESH_MS on the queue detail page / run
// inspector).
const LIVE_GAUGE_FRESH_MS = 90_000;

export const handle: Handle = {
  agentPageContext: (data) => queuesAgentPageContext(data),
};

export const meta = pageMeta("Queues");

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const url = new URL(request.url);
  const { page, query, period, from, to, sort } = SearchParamsSchema.parse(
    Object.fromEntries(url.searchParams)
  );

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  // Per-org gate for the metrics UI. When off, this org gets the classic Queues page and
  // no metrics query fires.
  const queueMetricsUiEnabled = await canAccessQueueMetricsUi({
    request,
    userId,
    organizationSlug,
  });

  const maxPeriodDays = queueMetricsUiEnabled
    ? await queueMetricsMaxPeriodDays(environment.organizationId)
    : QUEUE_METRICS_RETENTION_DAYS;
  const defaultPeriod = clampQueueMetricsPeriod(
    queueMetricsPeriodFromRequest(request),
    maxPeriodDays
  );

  try {
    const queueListPresenter = new QueueListPresenter();
    const queues = await queueListPresenter.call({
      environment,
      query,
      page,
      // Relevance ordering rides the metrics pipeline, so it is part of the gated UI.
      sort: queueMetricsUiEnabled ? (sort ?? "busiest") : "name",
    });

    const environmentQueuePresenter = new EnvironmentQueuePresenter();

    const autoReloadPollIntervalMs = env.QUEUES_AUTORELOAD_POLL_INTERVAL_MS;

    // Per-queue list metrics (Delay p95 + backlog sparkline columns) are SSR'd with the table.
    // The environment header tiles are fetched client-side per card (see QueueEnvMetricChart) so a
    // slow ClickHouse query never blocks the queues list from rendering.
    let metrics: {
      bucketStartMs: number;
      bucketIntervalMs: number;
      byQueue: Record<string, QueueListMetric>;
    } | null = null;

    if (queueMetricsUiEnabled) {
      // Metrics are additive observability; a ClickHouse hiccup must not take down queue
      // management. Fail open to metrics: null instead of bubbling to the page-level 400.
      try {
        const presenter = new QueueMetricsPresenter();
        const queueNames = queues.queues.map((q) =>
          q.type === "task" ? `task/${q.name}` : q.name
        );
        const timeRange = clipQueueMetricsWindow(
          timeFilterFromTo({
            period:
              resolveQueueMetricsPeriod({ period, from, to, defaultPeriod, maxPeriodDays }) ??
              undefined,
            from: parseFiniteInt(from),
            to: parseFiniteInt(to),
            defaultPeriod,
          }),
          maxPeriodDays
        );
        const queueMetrics =
          queueNames.length > 0
            ? await presenter.getQueueListMetrics({
                environment,
                queueNames,
                from: timeRange.from,
                to: timeRange.to,
              })
            : null;
        if (queueMetrics) {
          metrics = {
            bucketStartMs: queueMetrics.bucketStartMs,
            bucketIntervalMs: queueMetrics.bucketIntervalMs,
            byQueue: Object.fromEntries(queueMetrics.byQueue),
          };
        }
      } catch (error) {
        logger.warn("Queue list metrics unavailable, rendering without them", { error });
      }
    }

    // Allocation summary (Environment limit + Allocated tiles) is additive; a presenter
    // failure must not 400 the page, so fail open to null like the metrics block above.
    let allocation: Awaited<ReturnType<QueueAllocationPresenter["call"]>> | null = null;
    if (queueMetricsUiEnabled) {
      try {
        allocation = await new QueueAllocationPresenter().call({ environment });
      } catch (error) {
        logger.warn("Queue allocation summary unavailable, rendering without it", { error });
      }
    }

    return typedjson({
      ...queues,
      environment: await environmentQueuePresenter.call(environment),
      autoReloadPollIntervalMs,
      metrics,
      allocation,
      queueMetricsUiEnabled,
      defaultPeriod,
      maxPeriodDays,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  if (request.method.toLowerCase() !== "post") {
    return redirectWithErrorMessage(
      `/orgs/${params.organizationSlug}/projects/${params.projectParam}/env/${params.envParam}/queues`,
      request,
      "Wrong method"
    );
  }

  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const formData = await request.formData();
  const action = formData.get("action");

  const url = new URL(request.url);
  const redirectPath = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/queues${url.search}`;

  if (environment.archivedAt) {
    return redirectWithErrorMessage(redirectPath, request, "This branch is archived");
  }

  // Per-queue actions (pause/resume/override/remove-override) are shared with the queue detail
  // route, so they live in a helper that both routes call.
  const queueMutation = await handleQueueMutationAction({
    request,
    environment,
    userId,
    formData,
    redirectPath,
  });
  if (queueMutation) {
    return queueMutation;
  }

  switch (action) {
    case "environment-pause": {
      const pauseService = new PauseEnvironmentService();
      const result = await pauseService.call(environment, "paused");
      if (!result.success) {
        return redirectWithErrorMessage(redirectPath, request, result.error);
      }
      return redirectWithSuccessMessage(redirectPath, request, "Environment paused");
    }
    case "environment-resume": {
      const resumeService = new PauseEnvironmentService();
      const result = await resumeService.call(environment, "resumed");
      if (!result.success) {
        return redirectWithErrorMessage(redirectPath, request, result.error);
      }
      return redirectWithSuccessMessage(redirectPath, request, "Environment resumed");
    }
    default:
      return redirectWithErrorMessage(redirectPath, request, "Something went wrong");
  }
};

// Derives the environment concurrency status ("limit" | "burst" | "within") and the matching
// text color from the current running count vs. the env limit and burst factor. Shared by both
// the classic and metrics views so the "Running" tile styling stays in sync.
function getEnvConcurrencyLimitStatus(environment: {
  running: number;
  concurrencyLimit: number;
  burstFactor: number;
}) {
  const limitStatus =
    environment.running === environment.concurrencyLimit * environment.burstFactor
      ? "limit"
      : environment.running > environment.concurrencyLimit
        ? "burst"
        : "within";

  const limitClassName =
    limitStatus === "burst" ? "text-warning" : limitStatus === "limit" ? "text-error" : undefined;

  return { limitStatus, limitClassName };
}

export default function Page() {
  // Per-org flag decides which whole page renders. Off => the classic Queues page,
  // byte-for-byte the pre-metrics UI. Each branch is its own component (own hooks).
  const { queueMetricsUiEnabled } = useTypedLoaderData<typeof loader>();
  return queueMetricsUiEnabled ? <QueuesWithMetricsView /> : <ClassicQueuesView />;
}

function QueuesWithMetricsView() {
  const {
    environment,
    queues,
    pagination,
    totalQueues,
    hasFilters,
    autoReloadPollIntervalMs,
    metrics,
    allocation,
    defaultPeriod,
    maxPeriodDays,
  } = useTypedLoaderData<typeof loader>();

  const metricsByQueue = metrics?.byQueue ?? {};

  const organization = useOrganization();
  const project = useProject();
  const env = useEnvironment();
  const plan = useCurrentPlan();

  // The header tiles fetch client-side with the same period/from/to the TimeFilter writes.
  const { value } = useSearchParams();
  const timeRange = {
    period: resolveQueueMetricsPeriod({
      period: value("period"),
      from: value("from"),
      to: value("to"),
      defaultPeriod,
      maxPeriodDays,
    }),
    from: value("from") ?? null,
    to: value("to") ?? null,
  };
  useRememberQueueMetricsPeriod(value("period"));

  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true });

  // Drag-to-zoom on either chart narrows the page's from/to search params, which the
  // TimeFilter and the client-side metric queries both read (same wiring as the Agent page).
  const zoomToTimeFilter = useZoomToTimeFilter();

  // Live env-wide Queued/Running blocks. First paint uses the loader's Redis-exact values; from the
  // first poll on we prefer ClickHouse so the blocks stay current without a full page revalidate.
  // Empty rows (quiet env, or the very first fetch still in flight) fall back to the loader values,
  // so we never flash a stale 0. Fixed 15m window, env-wide (no queue filter), CH-only recurring
  // load; pauses while the tab is hidden (handled inside the hook).
  const { rows: liveBlockRows, responseReceivedAt } = useMetricResourceQuery(
    QUEUE_LIVE_BLOCKS_QUERY,
    {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: env.id,
      timeRange: { period: QUEUE_LIVE_BLOCKS_PERIOD, from: null, to: null },
      defaultPeriod: QUEUE_LIVE_BLOCKS_PERIOD,
      fillGaps: false,
      refreshIntervalMs: 15_000,
    }
  );
  const lastLiveBlockRow =
    liveBlockRows.length > 0 ? liveBlockRows[liveBlockRows.length - 1] : null;
  // Only trust the gauge while its newest bucket is fresh. A row painted from the hook's cache on
  // client-side nav-back (responseCache), or a quiet env whose latest bucket is minutes old, must
  // not override the loader's Redis-exact live values with a stale count.
  const lastLiveBucketMs = lastLiveBlockRow ? tileTimeToMs(lastLiveBlockRow.t) : NaN;
  const liveBlockIsFresh = useIsMetricResponseFresh(
    responseReceivedAt,
    lastLiveBucketMs,
    LIVE_GAUGE_FRESH_MS
  );
  const freshLiveBlockRow = lastLiveBlockRow && liveBlockIsFresh ? lastLiveBlockRow : null;
  const envQueuedLive = freshLiveBlockRow
    ? tileNumber(freshLiveBlockRow.env_queued)
    : environment.queued;
  const envRunningLive = freshLiveBlockRow
    ? tileNumber(freshLiveBlockRow.env_running)
    : environment.running;

  // Allocation summary tiles. The presenter computes the env-wide allocated total (sum of
  // each queue's explicit limit clamped to the env limit) in a single aggregate query.
  const envLimit = environment.concurrencyLimit;
  const burstLimit = Math.round(envLimit * environment.burstFactor);
  const allocated = allocation?.allocated ?? 0;
  const allocationPct = envLimit > 0 ? Math.round((allocated / envLimit) * 100) : 0;
  const overAllocated = allocated > envLimit;

  // Running-block tinting (burst/limit) tracks the live running value, not the loader snapshot.
  const { limitStatus, limitClassName } = getEnvConcurrencyLimitStatus({
    running: envRunningLive,
    concurrencyLimit: environment.concurrencyLimit,
    burstFactor: environment.burstFactor,
  });

  // Client-side, header-click sorting over the current page's rows. Server pagination and the
  // default busiest order are unchanged; clearing a sort returns to that server order.
  const queueRows = queues ?? [];

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Queues" />
        <PageAccessories>
          <AdminDebugTooltip />
          <WhenAgentUnavailable>
            <LinkButton
              variant={"docs/small"}
              LeadingIcon={BookOpenIcon}
              to={docsPath("/queue-concurrency")}
            >
              Queues docs
            </LinkButton>
          </WhenAgentUnavailable>
        </PageAccessories>
      </NavBar>
      <MetricsLayout.Root>
        {/* Filters — pinned bar directly under the NavBar. This row is page-wide only: Period is
            the one control that changes the tiles and charts below, so it leads the row. Search
            and pagination scope the table alone and live in that table's own bar instead. */}
        <MetricsLayout.Filters className="px-2">
          <div className="flex items-center gap-1.5">
            <TimeFilter
              period={timeRange.period ?? undefined}
              defaultPeriod={defaultPeriod}
              labelName="Period"
              maxPeriodDays={maxPeriodDays}
              shortcut={{ key: "d" }}
            />
          </div>
          <div className="flex items-center gap-1.5">
            {environment.runsEnabled &&
            env.pauseSource !== ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT ? (
              <EnvironmentPauseResumeButton env={env} />
            ) : null}
          </div>
        </MetricsLayout.Filters>

        {/* Queued + Running + Allocated + Environment limit summary. Four stat tiles: the grid
            derives its columns from the tile count (two-up, four-up from lg). The allocation
            presenter fails open to null (a ClickHouse/PG hiccup mustn't take down the tiles), so
            only the Allocated tile depends on it — the other three + controls always render, and
            Allocated shows a "–" placeholder to keep the 4-tile grid shape stable. */}
        <MetricsLayout.Grid>
          <BigNumber
            title="Queued"
            value={envQueuedLive}
            suffix={env.paused ? <span className="text-warning">paused</span> : undefined}
            animate
            accessory={
              <span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <LinkButton
                  variant="minimal/small"
                  className="aspect-square px-1!"
                  LeadingIcon={RunsIcon}
                  leadingIconClassName="text-text-dimmed group-hover/button:text-text-bright"
                  to={v3RunsPath(organization, project, env, {
                    statuses: ["PENDING"],
                    period: "30d",
                    rootOnly: false,
                  })}
                  tooltip="View queued runs"
                />
              </span>
            }
            valueClassName={env.paused ? "text-warning tabular-nums" : "tabular-nums"}
            compactThreshold={1000000}
          />
          <BigNumber
            title="Running"
            value={envRunningLive}
            animate
            valueClassName={cn(limitClassName, "tabular-nums")}
            suffix={
              limitStatus === "burst" ? (
                <span
                  className={cn(limitClassName, "system:text-text-dimmed flex items-center gap-1")}
                >
                  Including {envRunningLive - environment.concurrencyLimit} burst runs{" "}
                  <BurstFactorTooltip environment={environment} />
                </span>
              ) : limitStatus === "limit" ? (
                "At concurrency limit"
              ) : undefined
            }
            accessory={
              <span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <LinkButton
                  variant="minimal/small"
                  className="aspect-square px-1!"
                  LeadingIcon={RunsIcon}
                  leadingIconClassName="text-text-dimmed group-hover/button:text-text-bright"
                  to={v3RunsPath(organization, project, env, {
                    statuses: ["DEQUEUED", "EXECUTING"],
                    period: "30d",
                    rootOnly: false,
                  })}
                  tooltip="View in-progress runs"
                />
              </span>
            }
            compactThreshold={1000000}
          />
          <BigNumber
            title={
              <span className="flex items-center gap-1">
                Allocated
                {allocation && overAllocated ? (
                  <InfoIconTooltip
                    content="The queue limits add up to more than the environment limit, so queues will compete for concurrency when the environment saturates."
                    buttonClassName="text-warning"
                  />
                ) : null}
              </span>
            }
            value={allocation ? allocated : undefined}
            formattedValue={allocation ? undefined : "–"}
            valueClassName={cn(allocation && overAllocated && "text-warning")}
            suffix={allocation ? `${allocationPct}% of the environment limit` : undefined}
            suffixClassName="text-text-dimmed"
          />
          <BigNumber
            title="Environment limit"
            value={envLimit}
            suffix={environment.burstFactor > 1 ? `bursts up to ${burstLimit}` : undefined}
            suffixClassName="text-text-dimmed"
            accessory={
              plan ? (
                plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
                  <LinkButton
                    to={concurrencyPath(organization, project, env)}
                    variant="secondary/small"
                    LeadingIcon={ConcurrencyIcon}
                    leadingIconClassName="text-amber-500"
                  >
                    Increase limit
                  </LinkButton>
                ) : (
                  <LinkButton
                    to={v3BillingPath(organization, "Upgrade your plan for more concurrency")}
                    variant="secondary/small"
                    LeadingIcon={ArrowUpCircleIcon}
                    leadingIconClassName="text-indigo-500"
                  >
                    Increase limit
                  </LinkButton>
                )
              ) : undefined
            }
          />
        </MetricsLayout.Grid>

        {hasFilters || totalQueues !== 0 ? (
          <ChartSyncProvider onZoom={zoomToTimeFilter}>
            <MetricsLayout.Grid kind="charts">
              {QUEUE_HEADER_TILES.map((tile) => (
                <QueueEnvMetricChart
                  key={tile.id}
                  tile={tile}
                  timeRange={timeRange}
                  referenceLines={
                    tile.id === "saturation"
                      ? [
                          {
                            y: 100,
                            label: `Limit ${environment.concurrencyLimit}`,
                            labelPlacement: "outside" as const,
                          },
                          ...(environment.burstFactor > 1
                            ? [
                                {
                                  y: Math.round(environment.burstFactor * 100),
                                  label: `Burst ${Math.round(
                                    environment.concurrencyLimit * environment.burstFactor
                                  )}`,
                                  labelPlacement: "outside" as const,
                                },
                              ]
                            : []),
                        ]
                      : undefined
                  }
                  // Saturation recolours the line above its 100% limit with a gradient split, so
                  // only the portion over the line is orange (the offset is derived from the line's
                  // own value range, so the split lands exactly at 100% regardless of domain
                  // padding). p95 and throttled use a per-bucket overlay: it retraces only the
                  // over-threshold stretches, so under-threshold buckets stay blue.
                  thresholdStroke={
                    tile.id === "saturation"
                      ? { value: 100, aboveColor: "var(--color-warning)" }
                      : undefined
                  }
                  warningOverlay={
                    tile.id === "p95"
                      ? { threshold: 60_000 }
                      : tile.id === "throttled"
                        ? // Integer counts: threshold 0 warns once a bucket has ≥1 throttle.
                          { threshold: 0 }
                        : undefined
                  }
                />
              ))}
            </MetricsLayout.Grid>
          </ChartSyncProvider>
        ) : null}

        <MetricsLayout.Content
          /* Search + pagination only ever affect the table, so they sit on the table rather than
             in the page-wide Filters bar, where their position implied they filtered the metrics
             above. Same left/right split as the classic view's bar. */
          toolbar={
            <>
              <QueueFilters />
              <PaginationControls
                currentPage={pagination.currentPage}
                totalPages={pagination.mode === "unfiltered" ? pagination.totalPages : 1}
                hasNextPage={pagination.mode === "filtered" ? pagination.hasMore : undefined}
                showPageNumbers={false}
              />
            </>
          }
        >
          {/* Default overflow-x-auto container so wide tables still scroll horizontally on
                narrow viewports; the page (not this region) owns vertical scrolling. */}
          <Table containerClassName="border-t">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                <TableHeaderCell alignment="right">Running</TableHeaderCell>
                <TableHeaderCell
                  alignment="right"
                  disableTooltipHoverableContent
                  tooltip="How many runs can execute at once. For queues with a combinedConcurrencyLimit, the limit applies per concurrency key and the combined limit applies across all keys."
                >
                  Limit
                </TableHeaderCell>
                <TableHeaderCell
                  alignment="right"
                  tooltipContentClassName="max-w-max"
                  disableTooltipHoverableContent
                  tooltip={
                    <div className="max-w-max space-y-1 p-1 text-left text-xs text-text-dimmed">
                      <p>
                        <span className="text-text-bright">Environment</span>: uses the environment
                        limit of {environment.concurrencyLimit}.
                      </p>
                      <p>
                        <span className="text-text-bright">User</span>: a limit you set in your
                        code.
                      </p>
                      <p>
                        <span className="text-text-bright">Override</span>: a limit you set here or
                        via the API.
                      </p>
                    </div>
                  }
                >
                  Limited by
                </TableHeaderCell>
                <TableHeaderCell alignment="right">Health</TableHeaderCell>
                <TableHeaderCell
                  alignment="right"
                  disableTooltipHoverableContent
                  tooltip="How long runs waited before starting (95% were faster), over the selected time."
                >
                  Delay p95
                </TableHeaderCell>
                <TableHeaderCell
                  alignment="right"
                  disableTooltipHoverableContent
                  tooltip={
                    <>
                      How many runs were waiting, over the selected time. <WarningSwatch /> marks
                      where the queue was throttled.
                    </>
                  }
                >
                  Backlog
                </TableHeaderCell>
                <TableHeaderCell className="w-[1%] pl-32">
                  <span className="sr-only">Pause/resume</span>
                </TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queueRows.length > 0 ? (
                queueRows.map((queue) => {
                  const limit = queue.concurrencyLimit ?? environment.concurrencyLimit;
                  const isAtConcurrencyLimit = queue.running >= limit;
                  const isAtQueueLimit =
                    environment.queueSizeLimit !== null &&
                    queue.queued >= environment.queueSizeLimit;
                  const queueFilterableName = queueMetricsKey(queue);
                  const queueMetric = metricsByQueue[queueFilterableName];
                  const queueDetailPath = v3QueuePath(organization, project, env, {
                    friendlyId: queue.id,
                  });
                  return (
                    <TableRow key={queue.name}>
                      <TableCell
                        to={queueDetailPath}
                        isTabbableCell
                        // The queue-type icon and the at-limit warning are real <button>s, so
                        // they render beside the link (leading/trailing), never inside it —
                        // otherwise the cell is invalid <a><button> nesting. The name stays the
                        // link. (Override state is already explained by the "Limited by" column.)
                        leadingContent={
                          <SimpleTooltip
                            button={
                              queue.type === "task" ? (
                                <TasksIcon
                                  className={cn(
                                    "size-[1.125rem] text-blue-500",
                                    queue.paused && "opacity-50"
                                  )}
                                />
                              ) : (
                                <QueuesIcon
                                  className={cn(
                                    "size-[1.125rem] text-purple-500",
                                    queue.paused && "opacity-50"
                                  )}
                                />
                              )
                            }
                            content={
                              queue.type === "task"
                                ? `This queue was automatically created from your "${queue.name}" task`
                                : "This is a custom queue you added in your code."
                            }
                          />
                        }
                        trailingContent={
                          isAtConcurrencyLimit ? (
                            <SimpleTooltip
                              button={<ExclamationTriangleIcon className="size-4 text-warning" />}
                              content="At concurrency limit: this queue is running as many runs as its limit allows; new runs wait in the backlog."
                              className="max-w-[230px]"
                              disableHoverableContent
                            />
                          ) : null
                        }
                      >
                        <span className="flex items-center gap-2">
                          <span className={queue.paused ? "opacity-50" : undefined}>
                            {queue.name}
                          </span>
                          {queue.paused ? (
                            <Badge variant="extra-small" className="text-warning">
                              Paused
                            </Badge>
                          ) : null}
                          {isAtQueueLimit ? (
                            <Badge variant="extra-small" className="text-error">
                              At queue limit
                            </Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell
                        to={queueDetailPath}
                        alignment="right"
                        actionClassName="pl-16 tabular-nums"
                        className={cn(
                          "w-[1%]",
                          queue.paused ? "opacity-50" : undefined,
                          isAtQueueLimit && "text-error"
                        )}
                      >
                        {queue.queued}
                      </TableCell>
                      <TableCell
                        to={queueDetailPath}
                        alignment="right"
                        actionClassName="pl-16 tabular-nums"
                        className={cn(
                          "w-[1%]",
                          queue.paused ? "opacity-50" : undefined,
                          queue.concurrency?.combined?.current != null &&
                            (queue.concurrency.combined.running ?? 0) >=
                              Math.min(
                                queue.concurrency.combined.current,
                                environment.concurrencyLimit
                              )
                            ? "text-warning"
                            : queue.running > 0 && "text-text-bright"
                        )}
                      >
                        {queue.running}
                      </TableCell>
                      <TableCell
                        to={queueDetailPath}
                        alignment="right"
                        actionClassName="pl-16 tabular-nums"
                        className={cn(
                          "w-[1%]",
                          queue.paused ? "opacity-50" : undefined,
                          queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                        )}
                      >
                        {queue.concurrencyLimitOverridePercent !== null ? (
                          <>
                            {limit}
                            <span className="ml-1 text-text-dimmed group-hover/table-row:text-text-bright">
                              ({formatOverridePercent(queue.concurrencyLimitOverridePercent)}%)
                            </span>
                          </>
                        ) : (
                          limit
                        )}
                        {queue.concurrency?.combined?.current != null ? (
                          <span className="ml-1 text-text-dimmed group-hover/table-row:text-text-bright">
                            /key ·{" "}
                            {Math.min(
                              queue.concurrency.combined.current,
                              environment.concurrencyLimit
                            )}{" "}
                            combined
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell
                        to={queueDetailPath}
                        alignment="right"
                        actionClassName="pl-16"
                        className={cn("w-[1%]", queue.paused ? "opacity-50" : undefined)}
                        // Keep the whole row navigable: the override explainer is a tooltip
                        // button, so it renders beside the link (trailing) rather than nested
                        // inside the <a>, and the label itself stays the link.
                        trailingContent={
                          queue.concurrency?.overriddenAt ? (
                            <InfoIconTooltip
                              content={
                                queue.concurrencyLimitOverridePercent !== null
                                  ? `Overridden at ${formatOverridePercent(
                                      queue.concurrencyLimitOverridePercent
                                    )}% of the environment limit.`
                                  : `This queue's concurrency limit has been manually overridden to ${limit}.`
                              }
                              contentClassName="max-w-[230px]"
                              disableHoverableContent
                              // Tighten the gap from the "Override" label to gap-1 (the cell's
                              // trailing adornment gap is gap-2; -ml-1 pulls the icon in 4px).
                              buttonClassName="-ml-1"
                            />
                          ) : undefined
                        }
                      >
                        {queue.concurrency?.overriddenAt
                          ? "Override"
                          : queue.concurrencyLimit
                            ? "User"
                            : "Environment"}
                      </TableCell>
                      <TableCell
                        to={queueDetailPath}
                        alignment="right"
                        className={cn(queue.paused ? "opacity-50" : undefined)}
                      >
                        <QueueHealthBadge
                          paused={queue.paused}
                          running={queue.running}
                          queued={queue.queued}
                          limit={limit}
                        />
                      </TableCell>
                      <TableCell
                        to={queueDetailPath}
                        alignment="right"
                        actionClassName="pl-16 tabular-nums"
                        className="w-[1%]"
                      >
                        {queueMetric && queueMetric.p95WaitMs !== null ? (
                          <span className="text-text-bright">
                            {formatWaitMs(queueMetric.p95WaitMs)}
                          </span>
                        ) : (
                          <span className="text-text-dimmed">–</span>
                        )}
                      </TableCell>
                      <TableCell to={queueDetailPath} alignment="right">
                        <MiniLineChart
                          data={queueMetric?.depthSparkline}
                          throttled={queueMetric?.throttledSparkline}
                          peak={queueMetric?.peakQueued}
                          bucketStartMs={metrics?.bucketStartMs}
                          bucketIntervalMs={metrics?.bucketIntervalMs}
                          width={134}
                          color="var(--color-queues-chart)"
                          unitLabel={{ singular: "queued", plural: "queued" }}
                          showPeak={false}
                          formatPeak={(v) => v.toLocaleString()}
                          peakTooltip={
                            queueMetric && queueMetric.throttledTotal > 0
                              ? `Peak queued; this queue was throttled ${queueMetric.throttledTotal.toLocaleString()} ${
                                  queueMetric.throttledTotal === 1 ? "time" : "times"
                                } in this period`
                              : "Peak queued in this period"
                          }
                        />
                      </TableCell>
                      <TableCellMenu
                        isSticky
                        visibleButtons={queue.paused && <QueuePauseResumeButton queue={queue} />}
                        hiddenButtons={!queue.paused && <QueuePauseResumeButton queue={queue} />}
                        popoverContent={
                          <>
                            {queue.paused ? (
                              <QueuePauseResumeButton
                                queue={queue}
                                variant="minimal/small"
                                fullWidth
                                showTooltip={false}
                              />
                            ) : (
                              <QueuePauseResumeButton
                                queue={queue}
                                variant="minimal/small"
                                fullWidth
                                showTooltip={false}
                              />
                            )}

                            <PopoverMenuItem
                              icon={RunsIcon}
                              leadingIconClassName="text-runs size-[1.125rem]"
                              title="View all runs"
                              to={v3RunsPath(organization, project, env, {
                                queues: [queueFilterableName],
                                period: "30d",
                                rootOnly: false,
                              })}
                            />
                            <PopoverMenuItem
                              icon={QueuesIcon}
                              leadingIconClassName="text-queues size-[1.125rem]"
                              title="View queued runs"
                              to={v3RunsPath(organization, project, env, {
                                queues: [queueFilterableName],
                                statuses: ["PENDING"],
                                period: "30d",
                                rootOnly: false,
                              })}
                            />
                            <PopoverMenuItem
                              icon={Spinner}
                              leadingIconClassName="text-queues animate-none"
                              title="View in-progress runs"
                              to={v3RunsPath(organization, project, env, {
                                queues: [queueFilterableName],
                                statuses: ["DEQUEUED", "EXECUTING"],
                                period: "30d",
                                rootOnly: false,
                              })}
                            />
                            <QueueOverrideConcurrencyButton
                              queue={queue}
                              environmentConcurrencyLimit={environment.concurrencyLimit}
                            />
                          </>
                        }
                      />
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={9}>
                    <div className="grid place-items-center py-6 text-text-dimmed">
                      <Paragraph>
                        {hasFilters ? "No queues found matching your filters" : "No queues found"}
                      </Paragraph>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </MetricsLayout.Content>
      </MetricsLayout.Root>
    </PageContainer>
  );
}

function EnvironmentPauseResumeButton({
  env,
}: {
  env: { type: RuntimeEnvironmentType; paused: boolean };
}) {
  const navigation = useNavigation();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (navigation.state === "loading" || navigation.state === "idle") {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setIsOpen(false);
    }
  }, [navigation.state]);

  const isLoading = Boolean(
    navigation.formData?.get("action") === (env.paused ? "environment-resume" : "environment-pause")
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <div>
        <TooltipProvider disableHoverableContent={true}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="cursor-pointer [&_button]:cursor-pointer">
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="secondary/small"
                    LeadingIcon={env.paused ? PlayIcon : PauseIcon}
                    leadingIconClassName={env.paused ? "text-success" : "text-warning"}
                    className={
                      env.paused
                        ? "border-success/60 text-success [&_span]:text-success hover:border-success"
                        : "border-warning/60 text-warning [&_span]:text-warning hover:border-warning"
                    }
                    aria-label={
                      env.paused
                        ? `Resumes ${environmentFullTitle(env)} so its runs can be dequeued again.`
                        : `Pauses all runs from being dequeued in ${environmentFullTitle(env)}. Any executing runs will continue to run.`
                    }
                  >
                    {env.paused
                      ? `Resume ${environmentFullTitle(env)} environment…`
                      : `Pause ${environmentFullTitle(env)} environment…`}
                  </Button>
                </DialogTrigger>
              </div>
            </TooltipTrigger>
            <TooltipContent className={"text-xs"}>
              {env.paused
                ? `Resumes ${environmentFullTitle(env)} so its runs can be dequeued again.`
                : `Pauses all runs from being dequeued in ${environmentFullTitle(env)}. Any executing runs will continue to run.`}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <DialogContent>
        <DialogHeader>{env.paused ? "Resume environment?" : "Pause environment?"}</DialogHeader>
        <div className="flex flex-col gap-3 pt-3">
          <Paragraph>
            {env.paused
              ? `This will allow runs to be dequeued in ${environmentFullTitle(env)} again.`
              : `This will pause all runs from being dequeued in ${environmentFullTitle(
                  env
                )}. Any executing runs will continue to run.`}
          </Paragraph>
          <Form method="post" onSubmit={() => setIsOpen(false)}>
            <input
              type="hidden"
              name="action"
              value={env.paused ? "environment-resume" : "environment-pause"}
            />
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  disabled={isLoading}
                  variant={env.paused ? "primary/medium" : "danger/medium"}
                  LeadingIcon={
                    isLoading ? <Spinner color="white" /> : env.paused ? PlayIcon : PauseIcon
                  }
                  shortcut={{ modifiers: ["mod"], key: "enter" }}
                >
                  {env.paused ? "Resume environment" : "Pause environment"}
                </Button>
              }
              cancelButton={
                <DialogClose asChild>
                  <Button type="button" variant="secondary/medium">
                    Cancel
                  </Button>
                </DialogClose>
              }
            />
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function isEnvironmentPauseResumeFormSubmission(
  formMethod: string | undefined,
  formData: FormData | undefined
) {
  if (!formMethod || !formData) {
    return false;
  }

  return (
    formMethod.toLowerCase() === "post" &&
    (formData.get("action") === "environment-pause" ||
      formData.get("action") === "environment-resume")
  );
}

export function QueueFilters() {
  return <SearchInput placeholder="Search queues…" paramName="query" resetParams={["page"]} />;
}

type MetricTileRow = Record<string, number | string | null>;

type TilePoint = { bucket: number; value: number | null };

// Inline colour swatch matching the chart's warning ("yellow") line — used in tooltip copy that
// refers to that colour instead of naming it, so the swatch always matches the chart.
function WarningSwatch() {
  return (
    <span
      className="mx-0.5 inline-block size-2.5 -translate-y-px rounded-[2px] align-middle"
      style={{ backgroundColor: "var(--color-warning)" }}
      aria-label="yellow"
    />
  );
}

type QueueHeaderTile = {
  id: string;
  label: string;
  /** Info-icon copy explaining what the chart shows, rendered next to the card title. */
  description: ReactNode;
  color: string;
  /** Optional inline legend rendered below the card title: a fixed set of {colored square, label}
   * entries, for charts where a colour (e.g. the orange warning line) needs explaining. */
  legend?: Array<{ color: string; label: string }>;
  query: string;
  /** Formats a single bucket's value in the chart tooltip. */
  formatValue?: (value: number) => string;
  /** Formats the y-axis tick labels. Without it the axis shows raw numbers (bad for durations
   * in ms or percent scales). Passed through to Chart.Line's yAxisProps.tickFormatter. */
  formatAxis?: (value: number) => string;
  /** Hover tooltip explaining the headline readout next to the title (e.g. what "9% of current
   * period" means). Without it the readout has no tooltip. */
  totalTooltip?: string;
  /** Turns one row per bucket into the per-bucket points the chart draws. A null value is a
   * bucket the metric has nothing to say about, and the line breaks there rather than reading 0. */
  derive: (rows: MetricTileRow[]) => {
    points: TilePoint[];
    total: number;
    formatTotal?: (total: number) => string;
    totalClassName?: string;
  };
  /**
   * Optional second query, run at the range's natural bucket width, that owns the headline readout.
   * For a headline that is not invariant to bucket width — a share of buckets, or a percentile,
   * as opposed to a max over gauges — deriving it from the plotted rows would move the number
   * whenever this tile's floor widens them. Only requested while the floor is actually widening
   * anything; on ranges whose natural width is already at or above the floor the chart's own rows
   * are identical and are reused.
   */
  readout?: {
    query: string;
    derive: (rows: MetricTileRow[]) => {
      total: number;
      formatTotal?: (total: number) => string;
      totalClassName?: string;
    };
  };
};

function tileNumber(value: number | string | null): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function tileTimeToMs(value: number | string | null): number {
  const s = String(value).replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}

/** Peak of a series, ignoring the buckets it has nothing to say about. */
function peakOf(points: TilePoint[]): number {
  return points.reduce((max, p) => (p.value === null ? max : Math.max(max, p.value)), 0);
}

const SCHEDULING_DELAY_QUERY = `SELECT timeBucket() AS t,\n  round(quantilesTDigestMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]) AS p95,\n  sum(wait_ms_count) AS samples\nFROM env_metrics\nGROUP BY t\nORDER BY t`;

const THROTTLED_QUERY = `SELECT timeBucket() AS t,\n  sum(throttled_count) AS throttled\nFROM env_metrics\nGROUP BY t\nORDER BY t`;

const QUEUE_HEADER_TILES: QueueHeaderTile[] = [
  {
    id: "saturation",
    label: "Env saturation",
    description: (
      <>
        How much of the environment's concurrency is in use. Turns <WarningSwatch /> above 100%,
        when it's into burst capacity.
      </>
    ),
    color: "var(--color-queues-chart)",
    legend: [
      { color: "var(--color-queues-chart)", label: "Saturation" },
      { color: "var(--color-warning)", label: "Over limit" },
    ],
    query: `SELECT timeBucket() AS t,\n  max(max_env_running) AS running,\n  max(max_env_limit) AS env_limit\nFROM env_metrics\nGROUP BY t\nORDER BY t`,
    formatValue: (v) => (v > 100 ? `${v}% — over the environment limit` : `${v}%`),
    formatAxis: (v) => `${v}%`,
    derive: (rows) => {
      const points = rows.map((r) => {
        const limit = tileNumber(r.env_limit);
        return {
          bucket: tileTimeToMs(r.t),
          value: limit > 0 ? Math.round((tileNumber(r.running) / limit) * 100) : 0,
        };
      });
      return { points, total: peakOf(points), formatTotal: (v) => `${v}% peak` };
    },
  },
  {
    id: "backlog",
    label: "Backlog",
    description: "How many runs are waiting across the environment, over time.",
    color: "var(--color-queues-chart)",
    query: `SELECT timeBucket() AS t,\n  max(max_env_queued) AS queued\nFROM env_metrics\nGROUP BY t\nORDER BY t`,
    derive: (rows) => {
      const points = rows.map((r) => ({
        bucket: tileTimeToMs(r.t),
        value: tileNumber(r.queued),
      }));
      return { points, total: peakOf(points), formatTotal: (v) => `${v.toLocaleString()} peak` };
    },
  },
  {
    id: "p95",
    label: "Scheduling delay p95",
    description: (
      <>
        How long runs wait before they start (95% start faster than this). Turns <WarningSwatch />{" "}
        above 1 minute.
      </>
    ),
    totalTooltip: "The worst p95 in the selected window.",
    color: "var(--color-queues-chart)",
    legend: [
      { color: "var(--color-queues-chart)", label: "p95" },
      { color: "var(--color-warning)", label: "Over 1 min" },
    ],
    query: SCHEDULING_DELAY_QUERY,
    formatValue: formatWaitMs,
    formatAxis: formatWaitMs,
    derive: (rows) => {
      const points = rows.map((r) => ({
        bucket: tileTimeToMs(r.t),
        value: tileNumber(r.samples) > 0 ? tileNumber(r.p95) : null,
      }));
      return { points, total: peakOf(points) };
    },
    readout: {
      query: SCHEDULING_DELAY_QUERY,
      /**
       * Merging quantile states over a wider bucket yields a p95 between the sub-buckets' own, so
       * the worst p95 has to be read at the range's natural width or a burst of slow starts shorter
       * than the plotted bucket is averaged away. Unlike the gauges, whose max of maxes is the same
       * at any width.
       */
      derive: (rows) => {
        const worst = rows.reduce(
          (max, r) => (tileNumber(r.samples) > 0 ? Math.max(max, tileNumber(r.p95)) : max),
          0
        );
        return {
          total: worst,
          formatTotal: (v) => (v > 0 ? formatWaitMs(v) : "–"),
          totalClassName: worst >= 60_000 ? "text-warning" : undefined,
        };
      },
    },
  },
  {
    id: "throttled",
    label: "Throttled",
    description: "How often runs were held back by a limit.",
    totalTooltip: "The share of the selected window with at least one blocked dequeue.",
    color: "var(--color-queues-chart)",
    legend: [{ color: "var(--color-warning)", label: "Throttled" }],
    query: THROTTLED_QUERY,
    derive: (rows) => {
      const points = rows.map((r) => ({
        bucket: tileTimeToMs(r.t),
        value: tileNumber(r.throttled),
      }));
      return { points, total: peakOf(points) };
    },
    readout: {
      query: THROTTLED_QUERY,
      /**
       * Share of the window that saw any throttling. A raw event sum isn't interpretable (it
       * scales with poll rate and window length); the fraction of buckets with a throttle is.
       * Gap fill zero-fills this counter, so every bucket in the window is present and the row
       * count is the honest denominator.
       */
      derive: (rows) => {
        const nonzero = rows.filter((r) => tileNumber(r.throttled) > 0).length;
        const pct = rows.length > 0 ? Math.round((nonzero / rows.length) * 100) : 0;
        return {
          total: pct,
          formatTotal: (v) => `${v}% of current period`,
          totalClassName: pct > 0 ? "text-warning" : undefined,
        };
      },
    },
  },
];

/**
 * Bucket floor shared by every hero tile. Scheduling delay and throttling are event-driven, so at
 * the 10-second width a short range would otherwise pick, most buckets hold no samples at all. One
 * floor for all four keeps their x-axes identical, which the shared hover crosshair relies on.
 */
const HERO_CHART_MIN_BUCKET_SECONDS = 60;

type TileTimeRange = MetricResourceTimeRange;

// Full-size env metric chart rendered inside a ChartCard. Same data path as before
// (client-side TRQL via useMetricResourceQuery with fillGaps), drawn as a line that
// participates in the shared hover + drag-to-zoom of the enclosing ChartSyncProvider.
function QueueEnvMetricChart({
  tile,
  timeRange,
  referenceLines,
  thresholdStroke,
  warningOverlay,
  solidWarning = false,
}: {
  tile: QueueHeaderTile;
  timeRange: TileTimeRange;
  referenceLines?: Array<{
    y: number;
    label?: string;
    labelPlacement?: "inside" | "outside";
  }>;
  thresholdStroke?: { value: number; aboveColor: string };
  warningOverlay?: { threshold: number };
  /** When set, the ENTIRE line turns warning-coloured if the series is ever non-zero (used for
   * throttling: any throttle in the window colours the whole line). Mutually exclusive with the
   * per-bucket warningOverlay. */
  solidWarning?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const sharedOptions = {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    timeRange,
    defaultPeriod: QUEUE_METRICS_DEFAULT_PERIOD,
    fillGaps: true,
  };

  const { rows, showLoading, failed } = useMetricResourceQuery(tile.query, {
    ...sharedOptions,
    minBucketSeconds: HERO_CHART_MIN_BUCKET_SECONDS,
  });

  const derived = tile.derive(rows);
  const points = derived.points;

  const plottedBucketMs = points.length > 1 ? points[1]!.bucket - points[0]!.bucket : 0;
  const floorWidenedBuckets =
    plottedBucketMs > 0 && plottedBucketMs <= HERO_CHART_MIN_BUCKET_SECONDS * 1000;
  const readoutQuery = tile.readout && floorWidenedBuckets ? tile.readout.query : "";
  const readoutResult = useMetricResourceQuery(readoutQuery, sharedOptions);

  const { total, formatTotal, totalClassName } = tile.readout
    ? tile.readout.derive(readoutQuery ? readoutResult.rows : rows)
    : derived;

  // Same point shape the shared axis/tooltip helpers expect.
  const data = points
    .map((p) => ({ bucket: p.bucket, [tile.id]: p.value }))
    .filter((p) => Number.isFinite(p.bucket));

  // Whole-line warning colour when the series was ever non-zero (throttling: one throttle in the
  // window colours the entire line). Otherwise the tile's normal colour.
  const wholeLineWarning = solidWarning && total > 0;
  const lineColor = wholeLineWarning ? "var(--color-warning)" : tile.color;

  const chartConfig = useMemo<ChartConfig>(
    () => ({ [tile.id]: { label: tile.label, color: lineColor } }),
    [tile.id, tile.label, lineColor]
  );

  const { tickFormatter, tooltipLabelFormatter } = buildActivityTimeAxis(data);
  const hasData = data.length > 0 && data.some((p) => Number(p[tile.id] ?? 0) > 0);

  // Peak readout lives in the card title (ChartCard has no dedicated value slot). A zero/empty
  // total renders no readout at all (skipping "0% peak", "0 peak", "0" and the p95 "–" placeholder)
  // so the card title stands alone until there's a non-zero value to show.
  const readoutLoading = tile.readout ? readoutResult.showLoading : showLoading;
  const readoutFailed = tile.readout ? readoutResult.failed : failed;
  const peak = readoutLoading ? (
    <span className="inline-block h-3 w-12 animate-pulse rounded bg-grid-bright" />
  ) : readoutFailed || total === 0 ? null : formatTotal ? (
    formatTotal(total)
  ) : (
    total.toLocaleString()
  );

  return (
    <ChartCard
      title={
        <span className="flex flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="flex items-center gap-1">
              {tile.label}
              <InfoIconTooltip
                content={tile.description}
                contentClassName="max-w-[230px]"
                disableHoverableContent
              />
            </span>
            {peak != null ? (
              tile.totalTooltip && !readoutLoading ? (
                <SimpleTooltip
                  button={
                    <span
                      className={cn(
                        "text-xs font-normal tabular-nums text-text-dimmed",
                        totalClassName
                      )}
                    >
                      {peak}
                    </span>
                  }
                  content={tile.totalTooltip}
                  className="max-w-[230px]"
                  disableHoverableContent
                />
              ) : (
                <span
                  className={cn(
                    "text-xs font-normal tabular-nums text-text-dimmed",
                    totalClassName
                  )}
                >
                  {peak}
                </span>
              )
            ) : null}
          </span>
          {tile.legend && (showLoading || hasData) ? (
            <span className="flex items-center gap-2">
              {tile.legend.map((item) => (
                <span
                  key={item.label}
                  className="flex items-center gap-1 text-xs font-normal text-text-dimmed"
                >
                  <span
                    className="size-2.5 rounded-[2px]"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.label}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      }
    >
      {showLoading ? (
        <QueueMetricChartSkeleton />
      ) : failed ? (
        <div className="flex h-full items-center justify-center text-xs text-text-dimmed">
          Unable to load metrics
        </div>
      ) : hasData ? (
        <Chart.Root
          config={chartConfig}
          data={data}
          dataKey="bucket"
          series={[tile.id]}
          fillContainer
        >
          <Chart.Line
            showDots={false}
            referenceLines={referenceLines}
            thresholdStroke={thresholdStroke}
            warningOverlay={warningOverlay}
            xAxisProps={{ tickFormatter }}
            yAxisProps={tile.formatAxis ? { tickFormatter: tile.formatAxis } : undefined}
            tooltipLabelFormatter={tooltipLabelFormatter}
            tooltipValueFormatter={tile.formatValue}
          />
        </Chart.Root>
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-text-dimmed">
          No activity
        </div>
      )}
    </ChartCard>
  );
}

function QueueMetricChartSkeleton() {
  return (
    <div className="flex h-full min-h-0 items-end gap-px rounded-sm">
      {Array.from({ length: 42 }).map((_, i) => (
        <div key={i} className="h-full flex-1 bg-background-dimmed" />
      ))}
    </div>
  );
}

/** Health as a stock Badge: color carries the state, w-fit keeps it content-width. */
type QueueHealth = {
  paused: boolean;
  running: number;
  queued: number;
  limit: number;
};

type QueueHealthLabel = "Paused" | "At capacity" | "Backlogged" | "Active" | "Idle";

// Single source of truth for the queue health decision, shared by the badge and the table's
// health-column sort so the sorted order always matches the labels shown.
function queueHealthLabel({ paused, running, queued, limit }: QueueHealth): QueueHealthLabel {
  if (paused) return "Paused";
  if (isQueueAtCapacity({ running, queued, limit })) return "At capacity";
  if (queued > 0) return "Backlogged";
  if (running > 0) return "Active";
  return "Idle";
}

// Tint + colored text, sized like the error status chips (see ErrorStatusBadge).
const QUEUE_HEALTH_STYLES: Record<QueueHealthLabel, string> = {
  Paused: "bg-warning/10 text-warning system:bg-warning system:text-white",
  "At capacity": "bg-warning/10 text-warning system:bg-warning system:text-white",
  Backlogged: "bg-blue-500/10 text-blue-500 system:bg-blue-500 system:text-white",
  Active: "bg-success/10 text-success system:bg-success system:text-white",
  Idle: "bg-charcoal-500/10 text-text-dimmed system:bg-charcoal-500 system:text-white",
};

function QueueHealthBadge(health: QueueHealth) {
  const label = queueHealthLabel(health);
  return (
    <span
      className={cn(
        "ml-auto inline-flex w-fit items-center rounded px-2 py-0.5 text-xs font-medium",
        QUEUE_HEALTH_STYLES[label]
      )}
    >
      {label}
    </span>
  );
}

// The `queue_metrics`-prefixed key a queue is stored under (task queues are prefixed `task/`).
function queueMetricsKey(queue: { type: string; name: string }): string {
  return `${queue.type === "task" ? "task/" : ""}${queue.name}`;
}

function formatWaitMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

// Drop a trailing ".00" from whole percentages so "50.00" reads as "50" but "12.50" is preserved.
function formatOverridePercent(percent: number): string {
  return Number.isInteger(percent) ? percent.toString() : percent.toFixed(2).replace(/\.?0+$/, "");
}

// Classic Queues page, restored verbatim from before the Queue Metrics feature. Rendered
// when queueMetricsUiEnabled is off so a gated org sees exactly the pre-metrics UI.
function ClassicQueuesView() {
  const { environment, queues, pagination, hasFilters, autoReloadPollIntervalMs } =
    useTypedLoaderData<typeof loader>();

  const organization = useOrganization();
  const project = useProject();
  const env = useEnvironment();
  const plan = useCurrentPlan();

  useAutoRevalidate({ interval: autoReloadPollIntervalMs, onFocus: true });

  const { limitStatus, limitClassName } = getEnvConcurrencyLimitStatus(environment);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Queues" />
        <PageAccessories>
          <AdminDebugTooltip />
          <WhenAgentUnavailable>
            <LinkButton
              variant={"docs/small"}
              LeadingIcon={BookOpenIcon}
              to={docsPath("/queue-concurrency")}
            >
              Queues docs
            </LinkButton>
          </WhenAgentUnavailable>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <div className="grid grid-cols-3 gap-3 p-3">
            <BigNumber
              title="Queued"
              value={environment.queued}
              suffix={env.paused ? <span className="text-warning">paused</span> : undefined}
              animate
              accessory={
                <div className="flex items-start gap-1">
                  {environment.runsEnabled &&
                  env.pauseSource !== ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT ? (
                    <EnvironmentPauseResumeButton env={env} />
                  ) : null}
                  <LinkButton
                    variant="secondary/small"
                    LeadingIcon={RunsIcon}
                    leadingIconClassName="text-runs"
                    className="px-2"
                    to={v3RunsPath(organization, project, env, {
                      statuses: ["PENDING"],
                      period: "30d",
                      rootOnly: false,
                    })}
                    tooltip="View queued runs"
                  />
                </div>
              }
              valueClassName={env.paused ? "text-warning tabular-nums" : "tabular-nums"}
              compactThreshold={1000000}
            />
            <BigNumber
              title="Running"
              value={environment.running}
              animate
              valueClassName={cn(limitClassName, "tabular-nums")}
              suffix={
                limitStatus === "burst" ? (
                  <span
                    className={cn(
                      limitClassName,
                      "system:text-text-dimmed flex items-center gap-1"
                    )}
                  >
                    Including {environment.running - environment.concurrencyLimit} burst runs{" "}
                    <BurstFactorTooltip environment={environment} />
                  </span>
                ) : limitStatus === "limit" ? (
                  "At concurrency limit"
                ) : undefined
              }
              accessory={
                <LinkButton
                  variant="secondary/small"
                  LeadingIcon={RunsIcon}
                  leadingIconClassName="text-runs"
                  className="px-2"
                  to={v3RunsPath(organization, project, env, {
                    statuses: ["DEQUEUED", "EXECUTING"],
                    period: "30d",
                    rootOnly: false,
                  })}
                  tooltip="View running runs"
                />
              }
              compactThreshold={1000000}
            />
            <BigNumber
              title="Concurrency limit"
              value={environment.concurrencyLimit}
              animate
              valueClassName={limitClassName}
              suffix={
                environment.burstFactor > 1 ? (
                  <span
                    className={cn(
                      limitClassName,
                      "system:text-text-dimmed flex items-center gap-1"
                    )}
                  >
                    Burst limit {environment.burstFactor * environment.concurrencyLimit}{" "}
                    <BurstFactorTooltip environment={environment} />
                  </span>
                ) : undefined
              }
              accessory={
                plan ? (
                  plan?.v3Subscription?.plan?.limits.concurrentRuns.canExceed ? (
                    <LinkButton
                      to={concurrencyPath(organization, project, env)}
                      variant="tertiary/small"
                      LeadingIcon={ConcurrencyIcon}
                      leadingIconClassName="text-amber-500"
                    >
                      Increase limit
                    </LinkButton>
                  ) : (
                    <LinkButton
                      to={v3BillingPath(organization, "Upgrade your plan for more concurrency")}
                      variant="secondary/small"
                      LeadingIcon={ArrowUpCircleIcon}
                      leadingIconClassName="text-indigo-500"
                    >
                      Increase limit
                    </LinkButton>
                  )
                ) : null
              }
            />
          </div>

          <div className="grid max-h-full min-h-full grid-rows-[auto_1fr] overflow-x-auto">
            <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-1.5 py-1.5">
              <QueueFilters />
              <PaginationControls
                currentPage={pagination.currentPage}
                totalPages={pagination.mode === "unfiltered" ? pagination.totalPages : 1}
                hasNextPage={pagination.mode === "filtered" ? pagination.hasMore : undefined}
                showPageNumbers={false}
              />
            </div>
            <Table containerClassName="border-t">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell alignment="right">Queued</TableHeaderCell>
                  <TableHeaderCell alignment="right">Running</TableHeaderCell>
                  <TableHeaderCell
                    alignment="right"
                    tooltip="How many runs can execute at once. For queues with a combinedConcurrencyLimit, the limit applies per concurrency key and the combined limit applies across all keys."
                  >
                    Limit
                  </TableHeaderCell>
                  <TableHeaderCell
                    alignment="right"
                    tooltip={
                      <div className="max-w-xs space-y-2 p-1 text-left">
                        <div className="space-y-0.5">
                          <Header3>Environment</Header3>
                          <Paragraph
                            variant="small"
                            className="text-wrap! text-text-dimmed"
                            spacing
                          >
                            This queue is limited by your environment's concurrency limit of{" "}
                            {environment.concurrencyLimit}.
                          </Paragraph>
                        </div>
                        <div className="space-y-0.5">
                          <Header3>User</Header3>
                          <Paragraph
                            variant="small"
                            className="text-wrap! text-text-dimmed"
                            spacing
                          >
                            This queue is limited by a concurrency limit set in your code.
                          </Paragraph>
                        </div>
                        <div className="space-y-0.5">
                          <Header3>Override</Header3>
                          <Paragraph
                            variant="small"
                            className="text-wrap! text-text-dimmed"
                            spacing
                          >
                            This queue's concurrency limit has been manually overridden from the
                            dashboard or API.
                          </Paragraph>
                        </div>
                      </div>
                    }
                  >
                    Limited by
                  </TableHeaderCell>
                  <TableHeaderCell className="w-[1%] pl-32">
                    <span className="sr-only">Pause/resume</span>
                  </TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {queues.length > 0 ? (
                  queues.map((queue) => {
                    const limit = queue.concurrencyLimit ?? environment.concurrencyLimit;
                    const isAtConcurrencyLimit = queue.running >= limit;
                    const isAtQueueLimit =
                      environment.queueSizeLimit !== null &&
                      queue.queued >= environment.queueSizeLimit;
                    const queueFilterableName = `${queue.type === "task" ? "task/" : ""}${
                      queue.name
                    }`;
                    return (
                      <TableRow key={queue.name}>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <QueueName {...queue} />
                            {queue.concurrency?.overriddenAt ? (
                              <SimpleTooltip
                                button={
                                  <Badge variant="extra-small" className="text-text-bright">
                                    Concurrency limit overridden
                                  </Badge>
                                }
                                content="This queue's concurrency limit has been manually overridden from the dashboard or API."
                                className="max-w-[230px]"
                                disableHoverableContent
                              />
                            ) : null}
                            {queue.paused ? (
                              <Badge variant="extra-small" className="text-warning">
                                Paused
                              </Badge>
                            ) : null}
                            {isAtQueueLimit ? (
                              <Badge variant="extra-small" className="text-error">
                                At queue limit
                              </Badge>
                            ) : null}
                            {isAtConcurrencyLimit ? (
                              <Badge variant="extra-small" className="text-warning">
                                At concurrency limit
                              </Badge>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell
                          alignment="right"
                          className={cn(
                            "w-[1%] pl-16 tabular-nums",
                            queue.paused ? "opacity-50" : undefined,
                            isAtQueueLimit && "text-error"
                          )}
                        >
                          {queue.queued}
                        </TableCell>
                        <TableCell
                          alignment="right"
                          className={cn(
                            "w-[1%] pl-16 tabular-nums",
                            queue.paused ? "opacity-50" : undefined,
                            queue.concurrency?.combined?.current != null &&
                              (queue.concurrency.combined.running ?? 0) >=
                                Math.min(
                                  queue.concurrency.combined.current,
                                  environment.concurrencyLimit
                                )
                              ? "text-warning"
                              : queue.running > 0 && "text-text-bright",
                            isAtConcurrencyLimit && "text-warning"
                          )}
                        >
                          {queue.running}
                        </TableCell>
                        <TableCell
                          alignment="right"
                          className={cn(
                            "w-[1%] pl-16 tabular-nums",
                            queue.paused ? "opacity-50" : undefined,
                            queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                          )}
                        >
                          {limit}
                          {queue.concurrency?.combined?.current != null ? (
                            <span className="ml-1 text-text-dimmed">
                              /key ·{" "}
                              {Math.min(
                                queue.concurrency.combined.current,
                                environment.concurrencyLimit
                              )}{" "}
                              combined
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell
                          alignment="right"
                          className={cn(
                            "w-[1%] pl-16",
                            queue.paused ? "opacity-50" : undefined,
                            isAtConcurrencyLimit && "text-warning",
                            queue.concurrency?.overriddenAt && "font-medium text-text-bright"
                          )}
                        >
                          {queue.concurrency?.overriddenAt ? (
                            <span className="text-text-bright">Override</span>
                          ) : queue.concurrencyLimit ? (
                            "User"
                          ) : (
                            "Environment"
                          )}
                        </TableCell>
                        <TableCellMenu
                          isSticky
                          visibleButtons={queue.paused && <QueuePauseResumeButton queue={queue} />}
                          hiddenButtons={!queue.paused && <QueuePauseResumeButton queue={queue} />}
                          popoverContent={
                            <>
                              {queue.paused ? (
                                <QueuePauseResumeButton
                                  queue={queue}
                                  variant="minimal/small"
                                  fullWidth
                                  showTooltip={false}
                                />
                              ) : (
                                <QueuePauseResumeButton
                                  queue={queue}
                                  variant="minimal/small"
                                  fullWidth
                                  showTooltip={false}
                                />
                              )}

                              <PopoverMenuItem
                                icon={RunsIcon}
                                leadingIconClassName="text-runs"
                                title="View all runs"
                                to={v3RunsPath(organization, project, env, {
                                  queues: [queueFilterableName],
                                  period: "30d",
                                  rootOnly: false,
                                })}
                              />
                              <PopoverMenuItem
                                icon={RectangleStackIcon}
                                leadingIconClassName="text-queues"
                                title="View queued runs"
                                to={v3RunsPath(organization, project, env, {
                                  queues: [queueFilterableName],
                                  statuses: ["PENDING"],
                                  period: "30d",
                                  rootOnly: false,
                                })}
                              />
                              <PopoverMenuItem
                                icon={Spinner}
                                leadingIconClassName="text-queues animate-none"
                                title="View running runs"
                                to={v3RunsPath(organization, project, env, {
                                  queues: [queueFilterableName],
                                  statuses: ["DEQUEUED", "EXECUTING"],
                                  period: "30d",
                                  rootOnly: false,
                                })}
                              />
                              <QueueOverrideConcurrencyButton
                                queue={queue}
                                environmentConcurrencyLimit={environment.concurrencyLimit}
                              />
                            </>
                          }
                        />
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <div className="grid place-items-center py-6 text-text-dimmed">
                        <Paragraph>
                          {hasFilters ? "No queues found matching your filters" : "No queues found"}
                        </Paragraph>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function BurstFactorTooltip({
  environment,
}: {
  environment: { burstFactor: number; concurrencyLimit: number };
}) {
  return (
    <InfoIconTooltip
      content={`Your single queue concurrency limit is capped at ${
        environment.concurrencyLimit
      }, but you can burst up to ${
        environment.burstFactor * environment.concurrencyLimit
      } when across multiple queues/tasks.`}
      contentClassName="max-w-[230px]"
    />
  );
}

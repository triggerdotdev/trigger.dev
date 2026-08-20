import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { QueueItem } from "@trigger.dev/core/v3/schemas";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { MainCenteredContainer, PageContainer } from "~/components/layout/AppLayout";
import { MetricsLayout } from "~/components/layout/MetricsLayout";
import { AnimatedOrgBannerBar } from "~/components/billing/AnimatedOrgBannerBar";
import { BigNumber } from "~/components/metrics/BigNumber";
import { Header3 } from "~/components/primitives/Headers";
import { WatchButton } from "~/components/dashboard-agent/WatchButton";
import { queueWatchRecommendation } from "~/components/dashboard-agent/watch-recommendations";
import { storedQueueName } from "~/components/queues/queue-name";
import { isQueueDegraded, OLDEST_WAIT_WARNING_MS } from "~/components/queues/queue-thresholds";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Spinner } from "~/components/primitives/Spinner";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import {
  Chart,
  type ChartConfig,
  type ChartState,
} from "~/components/primitives/charts/ChartCompound";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
import {
  QUEUE_METRIC_COLORS as COLORS,
  QueueMetricChartCard as QueueDetailChartCard,
  type QueueMetricIds as Ids,
  type QueueMetricTimeRange as TimeRangeParams,
  clickhouseTimeToMs,
  formatWaitMs,
  toNumber,
  useQueueMetric,
} from "~/components/queues/QueueMetricCards";
import { useIsMetricResponseFresh } from "~/hooks/useMetricResourceQuery";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { QueueRetrievePresenter } from "~/presenters/v3/QueueRetrievePresenter.server";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { SearchInput } from "~/components/primitives/SearchInput";
import { engine } from "~/v3/runEngine.server";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useInterval } from "~/hooks/useInterval";
import { PaginationControls } from "~/components/primitives/Pagination";
import type {
  ConcurrencyKeyRow,
  ConcurrencyKeysResponse,
} from "~/routes/resources.queues.concurrency-keys";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { requireUserId } from "~/services/session.server";
import { docsPath, EnvironmentParamSchema, v3RunsPath } from "~/utils/pathBuilder";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { cn } from "~/utils/cn";
import { redirectWithErrorMessage } from "~/models/message.server";
import { handleQueueMutationAction } from "~/models/queueMutation.server";
import {
  QueueOverrideConcurrencyButton,
  QueuePauseResumeButton,
} from "~/components/queues/QueueControls";
import {
  clampQueueMetricsPeriod,
  queueMetricsPeriodFromRequest,
  resolveQueueMetricsPeriod,
  useRememberQueueMetricsPeriod,
} from "~/components/queues/queueMetricsPeriod";
import { queueMetricsMaxPeriodDays } from "~/components/queues/queueMetricsPeriod.server";
import { LinkButton } from "~/components/primitives/Buttons";
import { InvestigateButton } from "~/components/dashboard-agent/InvestigateButton";
import { queueBacklogPrompt } from "~/components/dashboard-agent/investigate-prompts";
import { queueAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import type { Handle } from "~/utils/handle";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Paragraph } from "~/components/primitives/Paragraph";
import { InlineCode } from "~/components/code/InlineCode";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { BookOpenIcon } from "@heroicons/react/20/solid";
import { pageMeta } from "~/utils/pageTitle";

export const handle: Handle = {
  agentPageContext: (data) => queueAgentPageContext(data),
};

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.queue?.name ?? params.queueParam ?? "Queue",
  "Queues",
]);

const ParamsSchema = EnvironmentParamSchema.extend({ queueParam: z.string() });

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, queueParam } = ParamsSchema.parse(params);

  // This whole page is part of the metrics UI; gate it per-org (the list already hides
  // the only link to it, this is defense in depth).
  if (!(await canAccessQueueMetricsUi({ request, userId, organizationSlug }))) {
    throw new Response(undefined, { status: 404, statusText: "Not found" });
  }

  const url = new URL(request.url);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment)
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  const retrieve = await new QueueRetrievePresenter().call({ environment, queueInput: queueParam });
  if (!retrieve.success) {
    throw new Response(undefined, { status: 404, statusText: "Queue not found" });
  }

  const queue = retrieve.queue;
  const fullName = storedQueueName(queue);

  const maxPeriodDays = await queueMetricsMaxPeriodDays(environment.organizationId);

  const [ckBreakdown, oldestQueuedAt] = await Promise.all([
    engine.concurrencyKeyBreakdown(environment, fullName, { limit: CK_LIVE_LIMIT }),
    // Enqueue time of the oldest run still waiting in the queue right now (any queue, keyed or
    // not); undefined when the queue is empty. Drives the live "Oldest wait" block.
    engine.oldestMessageInQueue(environment, fullName),
  ]);

  // Charts + CH-derived stats are fetched client-side per card (see QueueDetailChartCard /
  // useQueueMetric) so the drill-down renders instantly. The loader only returns the live
  // "now" counts + identifiers the client fetches need.
  // Link the Queued block to this queue's pending runs (same filter the list uses).
  const queuedRunsPath = v3RunsPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam },
    { queues: [fullName], statuses: ["PENDING"], period: "30d", rootOnly: false }
  );

  return typedjson({
    queue,
    fullName,
    queuedRunsPath,
    // The override dialog caps at the environment's concurrency limit.
    environmentConcurrencyLimit: environment.maximumConcurrencyLimit,
    ckBreakdown,
    oldestQueuedAt: oldestQueuedAt ?? null,
    loadedAt: Date.now(),
    backPath: url.pathname.replace(/\/[^/]+$/, ""),
    defaultPeriod: clampQueueMetricsPeriod(queueMetricsPeriodFromRequest(request), maxPeriodDays),
    maxPeriodDays,
    ids: {
      organizationId: environment.organizationId,
      projectId: environment.projectId,
      environmentId: environment.id,
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, queueParam } = ParamsSchema.parse(params);

  const url = new URL(request.url);
  const redirectPath = `/orgs/${organizationSlug}/projects/${projectParam}/env/${envParam}/queues/${queueParam}${url.search}`;

  if (request.method.toLowerCase() !== "post") {
    return redirectWithErrorMessage(redirectPath, request, "Wrong method");
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response(undefined, { status: 404, statusText: "Project not found" });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment)
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });

  if (environment.archivedAt) {
    return redirectWithErrorMessage(redirectPath, request, "This branch is archived");
  }

  const formData = await request.formData();

  // Pause/resume/override actions are shared with the Queues list route; here we redirect back to
  // the detail page so the user stays put.
  const result = await handleQueueMutationAction({
    request,
    environment,
    userId,
    formData,
    redirectPath,
  });
  if (result) return result;

  return redirectWithErrorMessage(redirectPath, request, "Something went wrong");
};

const CK_LIVE_LIMIT = 50;

/**
 * Bucket floor for the charts in a synced group. The event-driven series (scheduling delay,
 * throttling) need it: their samples only exist when something started or was held back, so at the
 * 10-second width a short range picks, most buckets hold nothing and the line reads as a run of
 * zeros. The gauges beside them take the same floor because the shared hover crosshair is a
 * recharts ReferenceLine on a category x-axis, so it only draws where the hovered bucket
 * timestamp exists in the other chart's own data — mixing widths in one group silently drops it.
 */
const SYNCED_CHART_MIN_BUCKET_SECONDS = 60;

// Whole-queue oldest wait right now: for keyed queues the per-key breakdown carries the oldest
// enqueue time per key, so the queue's oldest is the max wait across keys; otherwise fall back to
// the queue's oldest message directly. Returns null when nothing is waiting.
function wholeQueueOldestWaitMs(
  breakdown: CkBreakdown,
  oldestQueuedAt: number | null,
  now: number
): number | null {
  // Only keys with a live backlog (queued > 0) count — a lingering ckIndex entry whose subqueue
  // has drained would otherwise over-report the oldest wait. Matches the worstKeyNow guard below.
  const waitingKeys = breakdown.keys.filter((k) => k.queued > 0);
  if (waitingKeys.length > 0) {
    return waitingKeys.reduce((max, k) => Math.max(max, now - k.oldestEnqueuedAt), 0);
  }
  return oldestQueuedAt !== null ? Math.max(0, now - oldestQueuedAt) : null;
}

export default function Page() {
  const {
    queue,
    fullName,
    queuedRunsPath,
    environmentConcurrencyLimit,
    ckBreakdown,
    oldestQueuedAt,
    loadedAt,
    backPath,
    ids,
    defaultPeriod,
    maxPeriodDays,
  } = useTypedLoaderData<typeof loader>();

  const { value, replace } = useSearchParams();
  const timeRange: TimeRangeParams = {
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

  // The Concurrency keys tab exists only for queues with key activity: live keys in the
  // ckIndex, or nonzero CK history in the selected range (one cached scalar query decides).
  const { rows: gateRows, showLoading: gateLoading } = useQueueMetric(
    `SELECT max(max_ck_backlogged) AS peak_keys, max(max_ck_wait_ms) AS peak_wait\nFROM queue_metrics`,
    { ids, timeRange, queueName: fullName }
  );
  const gateRow = gateRows[0];
  const hasHistory = gateRow
    ? toNumber(gateRow.peak_keys) > 0 || toNumber(gateRow.peak_wait) > 0
    : false;
  // Whether this queue has any concurrency-key activity to show (live keys in the ckIndex, or
  // nonzero CK history in the range). Both tabs always render; when a queue has no keys the
  // Concurrency keys tab shows an empty state instead of blank charts/table.
  const hasKeys = ckBreakdown.keys.length > 0 || (!gateLoading && hasHistory);
  const view = value("view") === "keys" ? "keys" : "overview";
  const selectedKey = value("key");

  const oldestWaitMs = wholeQueueOldestWaitMs(ckBreakdown, oldestQueuedAt, loadedAt);
  const degraded = isQueueDegraded({
    paused: queue.paused,
    running: queue.running,
    queued: queue.queued,
    limit: queue.concurrencyLimit ?? environmentConcurrencyLimit,
    oldestWaitMs,
  });

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title={queue.name} backButton={{ to: backPath, text: "Queues" }} />
      </NavBar>
      {/* Paused-queue banner — mirrors the environment-paused banner (OrgBanner) at the top of
          the page when this individual queue is paused. */}
      <AnimatedOrgBannerBar show={queue.paused} variant="warning">
        {`"${queue.name}" queue paused. No new runs will be dequeued and executed.`}
      </AnimatedOrgBannerBar>
      <MetricsLayout.Root>
        {/* Filters — search (concurrency keys) + time filter in one left cluster, above
            everything, like the Queues list. The time filter scopes the tab charts; search filters
            the keys table. The bar is pinned by the layout while the page scrolls. */}
        <MetricsLayout.Filters className="pl-1.5 pr-2">
          <div className="translate-y-px self-end pl-2">
            <TabContainer>
              <TabButton
                isActive={view === "overview"}
                layoutId="queue-detail-view"
                onClick={() => replace({ view: undefined, key: undefined })}
              >
                Overview
              </TabButton>
              <TabButton
                isActive={view === "keys"}
                layoutId="queue-detail-view"
                onClick={() => replace({ view: "keys" })}
              >
                Concurrency keys
              </TabButton>
            </TabContainer>
          </div>
          <div className="flex items-center gap-1.5">
            {view === "keys" && hasKeys ? (
              <SearchInput
                placeholder="Search keys…"
                paramName="query"
                resetParams={["key", "page"]}
              />
            ) : null}
            <TimeFilter
              period={timeRange.period ?? undefined}
              defaultPeriod={defaultPeriod}
              labelName="Period"
              maxPeriodDays={maxPeriodDays}
              shortcut={{ key: "d" }}
            />
            {/* Both buttons self-hide when the agent isn't available. Watch is
                pre-filled with this queue's recommendation. */}
            {degraded ? (
              <InvestigateButton
                prompt={queueBacklogPrompt(fullName)}
                variant="secondary"
                tooltip="Ask why this queue is backed up"
              />
            ) : null}
            {/* A paused queue can't drain or grow, so every watch it could offer is a
                promise nothing will keep until someone resumes it. */}
            {queue.paused ? null : (
              <WatchButton spec={queueWatchRecommendation(fullName, { oldestWaitMs })} />
            )}
            <QueueOverrideConcurrencyButton
              queue={queue}
              environmentConcurrencyLimit={environmentConcurrencyLimit}
              trigger="button"
            />
            <QueuePauseResumeButton
              queue={{ id: queue.id, name: queue.name, paused: queue.paused }}
              variant="secondary/small"
              withQueueName
            />
          </div>
        </MetricsLayout.Filters>

        {/* Live "right now" state of the whole queue — independent of the time filter above.
            QueueStats renders the stat-tile grid slot (see MetricsLayout.Grid inside it). */}
        <QueueStats
          queue={queue}
          environmentConcurrencyLimit={environmentConcurrencyLimit}
          queuedRunsPath={queuedRunsPath}
          oldestWaitMs={oldestWaitMs}
          ids={ids}
          timeRange={timeRange}
          queueName={fullName}
        />

        {/* Tabs + charts share the padded (inset) column. Both tabs always render; the keys tab
            shows an empty state when the queue has no concurrency keys. */}
        <MetricsLayout.Content inset>
          {view === "keys" ? (
            hasKeys ? (
              <ConcurrencyKeyCharts
                breakdown={ckBreakdown}
                loadedAt={loadedAt}
                ids={ids}
                timeRange={timeRange}
                queueName={fullName}
              />
            ) : (
              <ConcurrencyKeysBlankState />
            )
          ) : (
            <OverviewCharts ids={ids} timeRange={timeRange} queueName={fullName} />
          )}
        </MetricsLayout.Content>

        {/* The per-key table is full-bleed (no inset), matching the Queues list table, so it spans
            edge to edge. The drill-down that opens under it is charts, so it stays in the padded
            column. */}
        {view === "keys" && hasKeys ? (
          <>
            <MetricsLayout.Content>
              <KeyStatsTable ids={ids} timeRange={timeRange} queueName={fullName} />
            </MetricsLayout.Content>
            {selectedKey ? (
              <MetricsLayout.Content inset>
                <KeyDrilldown
                  keyName={selectedKey}
                  ids={ids}
                  timeRange={timeRange}
                  queueName={fullName}
                />
              </MetricsLayout.Content>
            ) : null}
          </>
        ) : null}
      </MetricsLayout.Root>
    </PageContainer>
  );
}

// Inline colour swatch for tooltip copy — matches the chart legend swatch (rounded-[2px]) and is
// nudged up 1px so it sits on the text baseline.
function ColorSwatch({ color }: { color: string }) {
  return (
    <span
      className="mx-0.5 inline-block size-2.5 -translate-y-px rounded-[2px] align-middle"
      style={{ backgroundColor: color }}
    />
  );
}

function OverviewCharts({
  ids,
  timeRange,
  queueName,
}: {
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
}) {
  const zoomToTimeFilter = useZoomToTimeFilter();
  return (
    <ChartSyncProvider onZoom={zoomToTimeFilter}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <QueueDetailChartCard
          title="Concurrency"
          info={
            <>
              How many runs are executing at once (<ColorSwatch color={COLORS.running} />) versus
              the queue's limit (<ColorSwatch color={COLORS.limit} />
              ). Turns <ColorSwatch color="var(--color-warning)" /> color when it reaches the limit.
            </>
          }
          showLegend
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t, max(max_running) AS running, max(max_limit) AS limit\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          series={[
            // Limit first so the grey reference draws underneath; Running (purple) sits on top.
            { key: "limit", label: "Limit", color: COLORS.limit },
            { key: "running", label: "Running", color: COLORS.running },
          ]}
          // Recolour Running above the limit line with a gradient split, so it's orange only where
          // it's actually over the limit — not on the way up. The threshold reads off the (roughly
          // constant) limit series.
          thresholdStroke={{
            series: "running",
            valueFromSeries: "limit",
            aboveColor: "var(--color-warning)",
          }}
          // The limit is a config value emitted only while the queue is active; back-fill its
          // leading zeros so the reference line doesn't start with a false 0→limit step.
          carryBackfill={["limit"]}
        />
        <QueueDetailChartCard
          title="Queue depth"
          info="How many runs are waiting in this queue over time."
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t, max(max_queued) AS queued\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          series={[{ key: "queued", label: "Queued", color: COLORS.queued }]}
        />
        <QueueDetailChartCard
          title="Throughput"
          info={
            <>
              Runs arriving (<ColorSwatch color={COLORS.limit} /> Enqueued) versus starting (
              <ColorSwatch color={COLORS.running} /> Started). Turns{" "}
              <ColorSwatch color="var(--color-warning)" /> color when Started falls behind.
            </>
          }
          showLegend
          extraLegend={[{ color: "var(--color-warning)", label: "Falling behind" }]}
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t,\n  deltaSumTimestampMerge(enqueue_delta) AS enqueued,\n  deltaSumTimestampMerge(started_delta) AS started\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          series={[
            // Enqueued is the neutral grey reference (same grey as the Limit line on Concurrency);
            // Started is the accent — purple while keeping up, warning where it drops below Enqueued.
            { key: "enqueued", label: "Enqueued", color: COLORS.limit },
            { key: "started", label: "Started", color: COLORS.running },
          ]}
          warningOverlay={{ series: "started", below: "enqueued" }}
        />
        <QueueDetailChartCard
          title="Scheduling delay"
          info="How long runs wait before they start."
          showLegend
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[1]) AS p50,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]) AS p95,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[4]) AS p99,\n  sum(wait_ms_count) AS samples\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          sampleCountColumn="samples"
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          valueFormat={formatWaitMs}
          series={[
            { key: "p50", label: "p50", color: COLORS.p50 },
            { key: "p95", label: "p95", color: COLORS.p95 },
            { key: "p99", label: "p99", color: COLORS.p99 },
          ]}
        />
        <QueueDetailChartCard
          title="Throttled"
          info={
            <>
              How often runs were held back by a limit (<ColorSwatch color={COLORS.throttled} />{" "}
              color).
            </>
          }
          className="aspect-[2/1] sm:col-span-2 sm:aspect-[4/1]"
          query={`SELECT timeBucket() AS t, sum(throttled_count) AS throttled\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          series={[{ key: "throttled", label: "Throttled", color: COLORS.throttled }]}
        />
      </div>
    </ChartSyncProvider>
  );
}

type CkBreakdown = {
  totalBackloggedKeys: number;
  keys: Array<{
    concurrencyKey: string;
    queued: number;
    running: number;
    oldestEnqueuedAt: number;
  }>;
};

// Standard empty state for a queue that has no concurrency keys (no live keys and no CK history).
// Small, centered panel — same pattern as the runs page's "Create your first task" state.
function ConcurrencyKeysBlankState() {
  return (
    <MainCenteredContainer className="max-w-md">
      <InfoPanel
        icon={ConcurrencyIcon}
        iconClassName="text-text-dimmed"
        panelClassName="max-w-full"
        title="No concurrency keys configured"
        accessory={
          <LinkButton
            to={docsPath("/queue-concurrency")}
            variant="docs/small"
            LeadingIcon={BookOpenIcon}
          >
            Concurrency docs
          </LinkButton>
        }
      >
        <Paragraph variant="small">
          This queue doesn't use concurrency keys. Add <InlineCode>concurrencyKey</InlineCode> to
          your task to shard the queue per tenant/user.
        </Paragraph>
      </InfoPanel>
    </MainCenteredContainer>
  );
}

function ConcurrencyKeyCharts({
  breakdown,
  loadedAt,
  ids,
  timeRange,
  queueName,
}: {
  breakdown: CkBreakdown;
  loadedAt: number;
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
}) {
  const zoomToTimeFilter = useZoomToTimeFilter();
  const { value, replace } = useSearchParams();
  // Same key search as the table: narrows the per-key charts too.
  const keyFilter = value("query")?.trim().toLowerCase() || undefined;

  // The live most-starved key: among keys with a live backlog, the one whose oldest waiting run
  // has been waiting longest right now. Names the culprit on the "Worst key wait" card so the chart
  // (which shows how bad, not who) points at a tenant you can click through to.
  const worstKeyNow = useMemo(() => {
    let worst: { key: string; waitMs: number } | null = null;
    for (const k of breakdown.keys) {
      if (k.queued <= 0) continue;
      const waitMs = Math.max(0, loadedAt - k.oldestEnqueuedAt);
      if (!worst || waitMs > worst.waitMs) worst = { key: k.concurrencyKey, waitMs };
    }
    return worst;
  }, [breakdown, loadedAt]);

  return (
    /* Per-key breakdown: which keys hold the backlog / do the work. */
    <ChartSyncProvider onZoom={zoomToTimeFilter}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <GroupedKeyChartCard
          title="Waiting runs by key"
          info="Runs waiting per key (top 8)."
          className="aspect-[2/1]"
          rankExpr="max(max_queued)"
          seriesExpr="max(max_queued)"
          fillGaps
          keyFilter={keyFilter}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
        />
        <GroupedKeyChartCard
          title="Throughput by key"
          info="Runs started per key (top 8)."
          className="aspect-[2/1]"
          rankExpr="deltaSumTimestampMerge(started_delta)"
          seriesExpr="deltaSumTimestampMerge(started_delta)"
          keyFilter={keyFilter}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
        />
        {/* Whole-queue health across keys (single series, queues-purple). */}
        <QueueDetailChartCard
          title="Keys with backlog"
          info="Keys with runs waiting at once."
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t, max(max_ck_backlogged) AS keys\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
          fillGaps
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          series={[{ key: "keys", label: "Keys", color: COLORS.running }]}
        />
        <QueueDetailChartCard
          title="Worst key wait"
          info="Longest wait across all keys."
          titleAccessory={
            worstKeyNow ? (
              <button
                type="button"
                onClick={() => replace({ key: worstKeyNow.key })}
                className="cursor-pointer text-xs font-normal tabular-nums text-text-dimmed transition-colors hover:text-text-bright"
              >
                {worstKeyNow.key} · {formatWaitMs(worstKeyNow.waitMs)} now
              </button>
            ) : null
          }
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t, max(max_ck_wait_ms) AS wait\nFROM queue_metrics\nGROUP BY t\nORDER BY t`}
          fillGaps
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          valueFormat={formatWaitMs}
          series={[{ key: "wait", label: "Max wait", color: COLORS.running }]}
        />
      </div>
    </ChartSyncProvider>
  );
}

// TRQL string literal escape (standard SQL doubling).
function trqlString(value: string): string {
  return value.replace(/'/g, "''");
}

const KEY_SERIES_COLORS = [
  "#34D399",
  "#6366F1",
  "#F59E0B",
  "#22D3EE",
  "#A78BFA",
  "#EF4444",
  "#F472B6",
  "#84CC16",
];

// A card title with an info "i" tooltip, matching the Queues header charts. Used by the grouped
// per-key charts (the plain single-series cards get the same treatment via QueueMetricChartCard).
function chartTitleWithInfo(title: string, info: string) {
  return (
    <span className="flex items-center gap-1.5">
      {title}
      <InfoIconTooltip content={info} contentClassName="max-w-[230px]" />
    </span>
  );
}

type GroupedKeyChartProps = {
  title: string;
  info: string;
  className?: string;
  /** Aggregate expression ranking keys over the whole range (top 8 charted). */
  rankExpr: string;
  /** Aggregate expression charted per (bucket, key). */
  seriesExpr: string;
  fillGaps?: boolean;
  valueFormat?: (value: number) => string;
  /** Search substring (from the page's key search) — narrows the charted keys, like the table. */
  keyFilter?: string;
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
};

// Two-step top-N: rank keys over the range, then chart those keys as grouped series
// (the per-key table is activity-bound, so ranking is a cheap scan). Rank wider than we chart so a
// search can match keys outside the top 8; then filter by the search and keep the top 8 of those.
function GroupedKeyChartCard(props: GroupedKeyChartProps) {
  const { rows, showLoading, failed } = useQueueMetric(
    `SELECT concurrency_key, ${props.rankExpr} AS peak\nFROM queue_metrics_by_key\nGROUP BY concurrency_key\nORDER BY peak DESC\nLIMIT 50`,
    { ids: props.ids, timeRange: props.timeRange, queueName: props.queueName }
  );
  const keyFilter = props.keyFilter;
  const keys = useMemo(() => {
    let names = rows.filter((r) => toNumber(r.peak) > 0).map((r) => String(r.concurrency_key));
    if (keyFilter) names = names.filter((n) => n.toLowerCase().includes(keyFilter));
    return names.slice(0, 8);
  }, [rows, keyFilter]);

  if (showLoading || failed || keys.length === 0) return null;
  return <GroupedKeySeries keys={keys} {...props} />;
}

function GroupedKeySeries({
  keys,
  title,
  info,
  className,
  seriesExpr,
  fillGaps,
  valueFormat,
  ids,
  timeRange,
  queueName,
}: GroupedKeyChartProps & { keys: string[] }) {
  const inList = keys.map((k) => `'${trqlString(k)}'`).join(", ");
  const { rows, showLoading, failed } = useQueueMetric(
    `SELECT timeBucket() AS t, concurrency_key, ${seriesExpr} AS v\nFROM queue_metrics_by_key\nWHERE concurrency_key IN (${inList})\nGROUP BY t, concurrency_key\nORDER BY t`,
    { ids, timeRange, queueName, fillGaps }
  );

  const data = useMemo(() => {
    const buckets = new Map<number, { bucket: number } & Record<string, number>>();
    for (const r of rows) {
      const bucket = clickhouseTimeToMs(r.t);
      if (!Number.isFinite(bucket)) continue;
      let point = buckets.get(bucket);
      if (!point) {
        point = { bucket } as { bucket: number } & Record<string, number>;
        buckets.set(bucket, point);
      }
      point[String(r.concurrency_key)] = toNumber(r.v);
    }
    return [...buckets.values()].sort((a, b) => a.bucket - b.bucket);
  }, [rows]);

  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    keys.forEach((k, i) => {
      cfg[k] = { label: k, color: KEY_SERIES_COLORS[i % KEY_SERIES_COLORS.length]! };
    });
    return cfg;
  }, [keys]);

  const { tickFormatter, tooltipLabelFormatter } = useMemo(
    () => buildActivityTimeAxis(data),
    [data]
  );
  const state: ChartState = showLoading ? "loading" : failed ? "invalid" : undefined;

  return (
    <div className={className ?? "h-64"}>
      <ChartCard title={chartTitleWithInfo(title, info)}>
        <Chart.Root
          config={chartConfig}
          data={data}
          dataKey="bucket"
          series={keys}
          state={state}
          fillContainer
        >
          <Chart.Line
            lineType="monotone"
            xAxisProps={{ tickFormatter }}
            yAxisProps={valueFormat ? { tickFormatter: (v: number) => valueFormat(v) } : undefined}
            tooltipLabelFormatter={tooltipLabelFormatter}
            tooltipValueFormatter={valueFormat}
          />
        </Chart.Root>
      </ChartCard>
    </div>
  );
}

// One page of the paginated per-key table. The ClickHouse tier is the authority (ranked by peak
// backlog over the window, with the total on every row so page + count are a single scan); each
// page's keys are enriched with live "now" counts from Redis server-side. Fetched per page rather
// than capped at 50, so high-cardinality queues (tens of thousands of keys) page through instead
// of silently truncating. See resources.queues.concurrency-keys.
function useConcurrencyKeys(opts: {
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
  search: string;
  page: number;
}) {
  const { ids, timeRange, queueName, search, page } = opts;
  const [data, setData] = useState<ConcurrencyKeysResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const body = useMemo(
    () =>
      JSON.stringify({
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        queueName,
        period: timeRange.period,
        from: timeRange.from,
        to: timeRange.to,
        search,
        page,
      }),
    [
      ids.organizationId,
      ids.projectId,
      ids.environmentId,
      queueName,
      timeRange.period,
      timeRange.from,
      timeRange.to,
      search,
      page,
    ]
  );

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    fetch("/resources/queues/concurrency-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    })
      .then((res) => res.json() as Promise<ConcurrencyKeysResponse>)
      .then((res) => {
        if (controller.signal.aborted) return;
        setData(res);
        setIsLoading(false);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setData({ success: false, error: error?.message ?? "Network error" });
          setIsLoading(false);
        }
      });
  }, [body]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Keep the live "now" counts fresh without a manual reload.
  useInterval({
    interval: 30_000,
    onLoad: false,
    onFocus: true,
    pauseWhenHidden: true,
    callback: load,
  });

  return { data, isLoading };
}

// Paginated per-key table: which keys hold the backlog / do the work. Clicking a key pins the
// drill-down charts via the `key` search param.
function KeyStatsTable({
  ids,
  timeRange,
  queueName,
}: {
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
}) {
  const { value, replace, del } = useSearchParams();
  const selectedKey = value("key");
  const search = value("query")?.trim() ?? "";
  const page = Math.max(1, Number(value("page")) || 1);

  const { data, isLoading } = useConcurrencyKeys({ ids, timeRange, queueName, search, page });

  const rows: ConcurrencyKeyRow[] = data?.success ? data.rows : [];
  const total = data?.success ? data.total : 0;
  const perPage = data?.success ? data.perPage : 25;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  // Only show a skeleton before the first response; keep prior rows visible while revalidating.
  const showLoading = isLoading && !data;

  // Recover from a page past the end: narrowing the time range (or a stale bookmarked URL) can
  // leave `page` beyond the result set, which comes back empty with the pagination control — shown
  // only when there's >1 page — hidden, stranding the reader. Once a response settles empty on a
  // page > 1, snap back to page 1 (whose data is fetched fresh) so there's always a way out.
  useEffect(() => {
    if (!isLoading && data?.success && data.rows.length === 0 && page > 1) {
      del("page");
    }
  }, [isLoading, data, page, del]);

  return (
    <div className="flex flex-col">
      {/* Title bar above the table, shown only when there's more than one page: the section title
          on the left, prev/next pagination on the right. Hidden entirely for a single page. */}
      {totalPages > 1 ? (
        <div className="flex items-center justify-between border-t px-3 py-2">
          <Header3>Concurrency keys</Header3>
          <PaginationControls currentPage={page} totalPages={totalPages} showPageNumbers={false} />
        </div>
      ) : null}
      {/* Full-bleed, edge-to-edge like the Queues list table: a top border, no rounded side box. */}
      <Table containerClassName="border-t">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Key</TableHeaderCell>
            <TableHeaderCell alignment="right">Queued now</TableHeaderCell>
            <TableHeaderCell alignment="right">Running now</TableHeaderCell>
            <TableHeaderCell alignment="right">Oldest wait</TableHeaderCell>
            <TableHeaderCell alignment="right">Started</TableHeaderCell>
            <TableHeaderCell alignment="right">Peak backlog</TableHeaderCell>
            <TableHeaderCell alignment="right">Mean delay</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {showLoading ? (
            <TableBlankRow colSpan={7} className="text-text-dimmed">
              Loading…
            </TableBlankRow>
          ) : rows.length === 0 ? (
            <TableBlankRow colSpan={7} className="text-text-dimmed">
              {search ? `No keys match “${search}”` : "No concurrency keys"}
            </TableBlankRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={row.key}
                isSelected={selectedKey === row.key}
                className="cursor-pointer"
                onClick={() => (selectedKey === row.key ? del("key") : replace({ key: row.key }))}
              >
                <TableCell>{row.key}</TableCell>
                <TableCell alignment="right">{row.queued.toLocaleString()}</TableCell>
                <TableCell alignment="right">{row.running.toLocaleString()}</TableCell>
                <TableCell alignment="right">
                  {row.oldestWaitMs === null ? "–" : formatWaitMs(row.oldestWaitMs)}
                </TableCell>
                <TableCell alignment="right">{row.started.toLocaleString()}</TableCell>
                <TableCell alignment="right">{row.peakBacklog.toLocaleString()}</TableCell>
                <TableCell alignment="right">
                  {row.meanWaitMs > 0 ? formatWaitMs(row.meanWaitMs) : "–"}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function KeyDrilldown({
  keyName,
  ids,
  timeRange,
  queueName,
}: {
  keyName: string;
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
}) {
  const pin = `concurrency_key = '${trqlString(keyName)}'`;
  const zoomToTimeFilter = useZoomToTimeFilter();
  return (
    <ChartSyncProvider onZoom={zoomToTimeFilter}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <QueueDetailChartCard
          title={`Key ${keyName}: backlog and running`}
          info={
            <>
              This key: waiting (Queued, <ColorSwatch color={COLORS.queued} /> color) vs running (
              <ColorSwatch color={COLORS.limit} /> color).
            </>
          }
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t, max(max_queued) AS queued, max(max_running) AS running\nFROM queue_metrics_by_key\nWHERE ${pin}\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          series={[
            // Running is the grey reference underneath; Queued (the backlog we care about) is the purple accent on top.
            { key: "running", label: "Running", color: COLORS.limit },
            { key: "queued", label: "Queued", color: COLORS.running },
          ]}
        />
        <QueueDetailChartCard
          title={`Key ${keyName}: throughput`}
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t, deltaSumTimestampMerge(started_delta) AS started\nFROM queue_metrics_by_key\nWHERE ${pin}\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          series={[{ key: "started", label: "Started", color: COLORS.running }]}
        />
        <QueueDetailChartCard
          title={`Key ${keyName}: mean scheduling delay`}
          className="aspect-[2/1]"
          query={`SELECT timeBucket() AS t, if(sum(wait_ms_count) > 0, round(sum(wait_ms_sum) / sum(wait_ms_count)), 0) AS wait, sum(wait_ms_count) AS samples\nFROM queue_metrics_by_key\nWHERE ${pin}\nGROUP BY t\nORDER BY t`}
          fillGaps
          minBucketSeconds={SYNCED_CHART_MIN_BUCKET_SECONDS}
          sampleCountColumn="samples"
          ids={ids}
          timeRange={timeRange}
          queueName={queueName}
          valueFormat={formatWaitMs}
          series={[{ key: "wait", label: "Mean delay", color: COLORS.running }]}
        />
      </div>
    </ChartSyncProvider>
  );
}

// Live "right now" snapshot of the whole queue: a hybrid feed. The loader (Redis/PG) supplies the
// first paint so these blocks render instantly; after that a tiny 15s ClickHouse poll keeps them
// fresh, always reading the newest gauge row and falling back to the loader values until the first
// poll lands (so we never flash 0). These blocks never change with the filter. Period trends
// (backlog, throughput, delay over time) live in the charts below.
// The oldest-wait warning threshold lives in ~/components/queues/queue-thresholds.

// How recent the newest ClickHouse gauge bucket must be to drive the live blocks. Above the 10s
// bucket + pipeline lag; past it we treat the queue as idle and fall back to the loader value.
const LIVE_GAUGE_FRESH_MS = 90_000;

function QueueStats({
  queue,
  environmentConcurrencyLimit,
  queuedRunsPath,
  oldestWaitMs,
  ids,
  timeRange,
  queueName,
}: {
  // Carries the percent override source-of-truth (not part of the shared QueueItem contract) so the
  // override dialog reopens in percent mode for percent-based overrides.
  queue: QueueItem & { concurrencyLimitOverridePercent: number | null };
  environmentConcurrencyLimit: number;
  queuedRunsPath: string;
  oldestWaitMs: number | null;
  ids: Ids;
  timeRange: TimeRangeParams;
  queueName: string;
}) {
  // Live "now" is empty for a queue that just drained, so add the window peak/worst as a dimmed
  // caption (styled like "bursts up to 50" on the Queues list) — a quiet queue still shows how
  // backed up it got recently. "worst_wait" is the window's worst head-of-line wait (max of the
  // oldest still-waiting run's age), the same metric as the live "Oldest wait" headline — not the
  // scheduling-delay percentiles of runs that already started. Only concurrency-keyed queues record
  // this (max_ck_wait_ms), so it's 0/absent for non-keyed queues.
  const { rows } = useQueueMetric(
    `SELECT max(max_queued) AS peak_queued,\n  max(max_ck_wait_ms) AS worst_wait\nFROM queue_metrics`,
    { ids, timeRange, queueName }
  );
  const peakQueued = rows[0] ? toNumber(rows[0].peak_queued) : 0;
  const worstWaitMs = rows[0] ? toNumber(rows[0].worst_wait) : 0;

  // Latest gauges from ClickHouse, polled every 15s so the live blocks keep ticking after first
  // paint. Read the newest bucket (largest t); until the first poll lands liveRows is empty and the
  // *Live values stay null, so the blocks show the loader values instead of flashing 0.
  const { rows: liveRows, responseReceivedAt } = useQueueMetric(
    `SELECT timeBucket() AS t, max(max_running) AS running, max(max_queued) AS queued, max(max_limit) AS q_limit, max(max_ck_wait_ms) AS ck_wait FROM queue_metrics GROUP BY t ORDER BY t`,
    {
      ids,
      timeRange: { period: "15m", from: null, to: null },
      defaultPeriod: "15m",
      queueName,
      refreshIntervalMs: 15_000,
    }
  );
  // Gauges are only emitted while the queue is active, so a drained queue's newest bucket is a past
  // one holding its last non-zero reading. Trust the CH gauge only when its newest bucket is recent
  // (covers the 10s bucket + pipeline lag); once it ages out we fall back to the loader's live
  // Redis/PG value instead of lingering on a stale count.
  const latest = liveRows.length > 0 ? liveRows[liveRows.length - 1] : undefined;
  const latestBucketMs = latest ? clickhouseTimeToMs(latest.t) : NaN;
  const liveFresh = useIsMetricResponseFresh(
    responseReceivedAt,
    latestBucketMs,
    LIVE_GAUGE_FRESH_MS
  );
  const fresh = latest && liveFresh ? latest : undefined;
  const runningLive = fresh ? toNumber(fresh.running) : null;
  const queuedLive = fresh ? toNumber(fresh.queued) : null;
  const limitLive = fresh ? toNumber(fresh.q_limit) : null;
  const ckWaitLive = fresh ? toNumber(fresh.ck_wait) : null;

  // Prefer CH once it has landed; loader values before that.
  const runningDisplay = runningLive ?? queue.running;
  const queuedDisplay = queuedLive ?? queue.queued;
  // Limit is queue config, not a live signal: keep the loader's value. Only if the loader had none
  // do we fall back to the CH gauge for display.
  const limitDisplay = queue.concurrencyLimit ?? (limitLive || null);
  // Keyed queues report head-of-line wait via CH (max_ck_wait_ms); use it as the live headline when
  // present. Non-keyed queues have no CH signal, so they stay on the loader value.
  const oldestWaitDisplayMs = ckWaitLive !== null && ckWaitLive > 0 ? ckWaitLive : oldestWaitMs;

  return (
    <MetricsLayout.Grid>
      <ConcurrencyBlock running={runningDisplay} limit={limitDisplay} paused={queue.paused} />
      <BigNumber
        title="Queued"
        value={queuedDisplay}
        valueClassName="tabular-nums"
        animate
        suffix={peakQueued > 0 ? `peak ${formatNumberCompact(peakQueued)}` : undefined}
        suffixClassName="text-text-dimmed"
        accessory={
          <span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <LinkButton
              variant="minimal/small"
              className="aspect-square px-1!"
              LeadingIcon={RunsIcon}
              leadingIconClassName="text-text-dimmed group-hover/button:text-text-bright"
              to={queuedRunsPath}
              tooltip="View queued runs"
            />
          </span>
        }
      />
      <BigNumber
        title="Oldest wait"
        formattedValue={
          oldestWaitDisplayMs !== null && oldestWaitDisplayMs > 0
            ? formatWaitMs(oldestWaitDisplayMs)
            : "0"
        }
        valueClassName={cn(
          "tabular-nums",
          oldestWaitDisplayMs !== null &&
            oldestWaitDisplayMs >= OLDEST_WAIT_WARNING_MS &&
            "text-warning"
        )}
        suffix={worstWaitMs > 0 ? `worst ${formatWaitMs(worstWaitMs)}` : undefined}
        suffixClassName="text-text-dimmed"
      />
    </MetricsLayout.Grid>
  );
}

/** Live concurrency as a single block: running vs limit with a utilization bar, so "how close to
 * the ceiling" reads at a glance instead of two separate numbers. Warning-tinted at/over the limit. */
function ConcurrencyBlock({
  running,
  limit,
  paused = false,
  loading,
  accessory,
}: {
  running: number;
  limit: number | null;
  paused?: boolean;
  loading?: boolean;
  accessory?: ReactNode;
}) {
  const atLimit = limit !== null && limit > 0 && running >= limit;
  const pct = limit && limit > 0 ? Math.min(100, Math.round((running / limit) * 100)) : 0;
  return (
    <div className="flex flex-col justify-between gap-4 rounded-lg border border-grid-bright bg-background-bright p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Header3 className="leading-6">Concurrency</Header3>
          {paused ? <span className="text-xs text-warning">paused</span> : null}
        </div>
        {accessory ? <div className="shrink-0">{accessory}</div> : null}
      </div>
      {loading ? (
        <Spinner className="size-6" />
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <span
              className={cn(
                "text-[3.75rem] font-normal leading-none tabular-nums",
                atLimit ? "text-warning" : "text-text-bright"
              )}
            >
              {running.toLocaleString()}
            </span>
            <span className="text-xl tabular-nums text-text-dimmed">
              / {limit !== null ? limit.toLocaleString() : "∞"}
            </span>
            {limit !== null && limit > 0 && (
              <span
                className={cn(
                  "text-xs tabular-nums",
                  atLimit ? "system-mono-label text-warning" : "text-text-dimmed"
                )}
              >
                {/* Separator so the limit and the percentage don't read as one number
                    (e.g. "/ 25" + "44%" mashing into "2544%"). */}
                <span className="mr-1 text-text-dimmed">·</span>
                {pct}% of limit
              </span>
            )}
          </div>
          {limit !== null && limit > 0 && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-charcoal-750">
              <div
                className={cn("h-full rounded-full", atLimit ? "bg-warning" : "bg-queues")}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

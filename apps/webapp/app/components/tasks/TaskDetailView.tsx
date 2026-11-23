import { BellAlertIcon } from "@heroicons/react/20/solid";
import { useLocation } from "@remix-run/react";
import type { TaskTriggerSource } from "@trigger.dev/database";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { ListPagination } from "~/components/ListPagination";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { ChartBlankState } from "~/components/primitives/charts/ChartBlankState";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { statusColor } from "~/components/primitives/charts/statusColors";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { DeferredContent } from "~/components/primitives/detail/DeferredContent";
import {
  DetailHeader,
  DetailPage,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
  useDetailTab,
  type DetailTab,
} from "~/components/primitives/detail/DetailPage";
import {
  ChartSkeleton,
  DetailTabEmpty,
  DetailTabError,
  DetailTabLoading,
  DetailTableTab,
} from "~/components/primitives/detail/DetailSections";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TextLink } from "~/components/primitives/TextLink";
import {
  QueueOverrideConcurrencyButton,
  QueuePauseResumeButton,
} from "~/components/queues/QueueControls";
import {
  QUEUE_METRIC_COLORS,
  QueueMetricChart,
  QueuePeriodStats,
} from "~/components/queues/QueueMetricCards";
import { RunsDisplayOptions } from "~/components/runs/v3/RunsDisplayOptions";
import { TimeFilter } from "~/components/runs/v3/SharedFilters";
import { taskTriggerSourceDescription } from "~/components/runs/v3/TaskTriggerSource";
import { NewRunsButton, TaskRunsList } from "~/components/runs/v3/TaskRunsList";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { CurrentVersionProvider, VersionLabel } from "~/components/versions/VersionLabel";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
import type { TaskDetailPageData } from "~/presenters/v3/TaskDetailPage.server";
import type { TaskActivity, TaskDetail } from "~/presenters/v3/TaskDetailPresenter.server";
import { retryWaits } from "./retryWaits";
import { taskRunsFilters } from "./taskRunsFilters";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import {
  concurrencyPath,
  concurrencyQueuePath,
  v3AlertCreatePath,
  v3CreateBulkActionPath,
  v3RunsPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";

/* The task page on the detail template, shared by the standard and scheduled task routes: header,
 * Runs and Queue tabs (plus any tab the route adds, e.g. Schedules), and the property rail. */

type Queue = NonNullable<TaskDetailPageData["queue"]>;

const TRIGGER_SOURCE_ICON: Record<TaskTriggerSource, { icon: typeof ClockIcon; color: string }> = {
  STANDARD: { icon: TaskIconSmall, color: "text-tasks" },
  SCHEDULED: { icon: ClockIcon, color: "text-schedules" },
  AGENT: { icon: CubeSparkleIcon, color: "text-agents" },
  WEBHOOK: { icon: WebhookIcon, color: "text-webhooks" },
};

/** The runs table's default columns, for the Runs and Queue tab skeletons. */
const RUN_SKELETON_COLUMNS = [
  { label: "ID" },
  { label: "Task" },
  { label: "Status" },
  { label: "Version" },
  { label: "Started" },
  { label: "Duration" },
  { label: "Machine" },
];

type TaskTabId = "runs" | "queue" | "schedules" | "sessions" | "deliveries" | "endpoints";

type ExtraTaskTab = {
  id: Exclude<TaskTabId, "runs" | "queue">;
  label: string;
  count?: string;
  content: ReactNode;
};

export function TaskDetailView({
  data,
  leadingTab,
  extraTab,
  primaryAction,
  secondaryActions,
  detailsExtra,
  railAfterDetails,
  railExtra,
}: {
  data: TaskDetailPageData;
  /** A tab before Runs that opens by default, e.g. an agent's Sessions or a webhook's Deliveries. */
  leadingTab?: ExtraTaskTab;
  /** A tab after Runs and Queue, e.g. a scheduled task's Schedules. */
  extraTab?: ExtraTaskTab;
  /** Replaces the header's Test task button, e.g. an agent's Playground. */
  primaryAction?: ReactNode;
  /** Shown before Watch and View runs. */
  secondaryActions?: ReactNode;
  /** Properties at the end of the rail's Details group. */
  detailsExtra?: ReactNode;
  /** Property groups between Details and Execution. */
  railAfterDetails?: ReactNode;
  /** Property groups after Execution, e.g. a scheduled task's next and last run. */
  railExtra?: ReactNode;
}) {
  const { task, currentVersion, queue } = data;
  const tabIds = [
    ...(leadingTab ? [leadingTab.id] : []),
    "runs" as const,
    "queue" as const,
    ...(extraTab ? [extraTab.id] : []),
  ];
  const [tab, setTab, isTabPending] = useDetailTab<TaskTabId>(tabIds);

  const tabs: DetailTab<TaskTabId>[] = [
    ...(leadingTab
      ? [{ id: leadingTab.id, label: leadingTab.label, count: leadingTab.count }]
      : []),
    { id: "runs", label: "Runs" },
    { id: "queue", label: "Queue", count: queue ? formatNumber(queue.queued) : undefined },
    ...(extraTab ? [{ id: extraTab.id, label: extraTab.label, count: extraTab.count }] : []),
  ];

  const extra = [leadingTab, extraTab].find((t) => t?.id === tab);

  return (
    <CurrentVersionProvider currentVersion={currentVersion}>
      <DetailPage
        id="task"
        header={
          <TaskHeader
            data={data}
            primaryAction={primaryAction}
            secondaryActions={secondaryActions}
          />
        }
        tabs={
          <DetailTabs
            tabs={tabs}
            activeTab={tab}
            onTabChange={(next) => setTab(next, { cursor: undefined, direction: undefined })}
            layoutId="task-tab"
          />
        }
        rail={
          <TaskRail
            data={data}
            detailsExtra={detailsExtra}
            afterDetails={railAfterDetails}
            extra={railExtra}
          />
        }
      >
        {extra ? (
          extra.content
        ) : tab === "queue" ? (
          <TaskQueueTab data={data} isPending={isTabPending} />
        ) : (
          <TaskRunsTab task={task} data={data} isPending={isTabPending} />
        )}
      </DetailPage>
    </CurrentVersionProvider>
  );
}

// ---------- Header ----------

function TaskHeader({
  data,
  primaryAction,
  secondaryActions,
}: {
  data: TaskDetailPageData;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
}) {
  const { task, queue, alertsEnabled } = data;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const kind = TRIGGER_SOURCE_ICON[task.triggerSource];

  const testPath = v3TestTaskPath(organization, project, environment, {
    taskIdentifier: task.slug,
  });
  const runsPath = v3RunsPath(organization, project, environment, { tasks: [task.slug] });
  const newAlertPath = v3AlertCreatePath(organization, project, environment, {
    area: "runs",
    scope: "task",
    scopeValue: task.slug,
  });

  return (
    <DetailHeader
      icon={kind.icon}
      iconClassName={kind.color}
      title={task.slug}
      mono
      friendlyId={task.slug}
      badges={queue?.paused ? <Badge variant="extra-small">Queue paused</Badge> : undefined}
      meta={[
        taskTriggerSourceDescription(task.triggerSource),
        ...(task.workerVersion
          ? [
              <span key="version" className="inline-flex items-center gap-1">
                Version <VersionLabel version={task.workerVersion} />
              </span>,
            ]
          : []),
        ...(queue ? [<QueueCounts key="counts" queue={queue} />] : []),
      ]}
      secondaryActions={
        <>
          {secondaryActions}
          {alertsEnabled ? (
            <LinkButton
              variant="secondary/small"
              to={newAlertPath}
              LeadingIcon={BellAlertIcon}
              leadingIconClassName="text-alerts"
              tooltip="Create a new alert"
            >
              Watch
            </LinkButton>
          ) : null}
          <LinkButton
            variant="secondary/small"
            to={runsPath}
            LeadingIcon={RunsIcon}
            leadingIconClassName="text-runs"
          >
            View runs
          </LinkButton>
        </>
      }
      primaryAction={
        primaryAction ?? (
          <LinkButton
            variant="primary/small"
            to={testPath}
            LeadingIcon={BeakerIcon}
            iconSpacing="gap-x-2"
            leadingIconClassName="-mx-2"
          >
            Test task
          </LinkButton>
        )
      }
    />
  );
}

/** "2 running, 14 queued", naming the queue when other tasks share it. */
function QueueCounts({ queue }: { queue: Queue }) {
  const shared = queue.type !== "task";
  return (
    <span className="truncate">
      <span className="tabular-nums">{formatNumber(queue.running)}</span> running,{" "}
      <span className="tabular-nums">{formatNumber(queue.queued)}</span> queued
      {shared ? ` in ${queue.name}` : ""}
    </span>
  );
}

// ---------- Runs ----------

function TaskRunsTab({
  task,
  data,
  isPending,
}: {
  task: TaskDetail;
  data: TaskDetailPageData;
  isPending: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const location = useLocation();
  const zoomToTimeFilter = useZoomToTimeFilter();

  // New-runs state is lifted here so the button sits in the toolbar while the count comes from
  // the live-reload hook inside the deferred table.
  const [newRunsCount, setNewRunsCount] = useState(0);
  const showNewRunsRef = useRef<() => void>(() => {});

  // The same time range and versions as the table below, so the links cover the runs it shows.
  const filters = taskRunsFilters(task.slug, new URLSearchParams(location.search));
  const runsPath = v3RunsPath(organization, project, environment, filters);
  const bulkReplayPath = v3CreateBulkActionPath(
    organization,
    project,
    environment,
    filters,
    "filter",
    "replay"
  );
  // The chart and table keep their last data while the same query reloads (live polling); a new
  // period or page starts over with the skeleton.
  const params = new URLSearchParams(location.search);
  params.delete("tab");
  const retainKey = params.toString();

  const tools = <TimeFilter defaultPeriod="7d" labelName="Runs" />;
  const actions = (
    <>
      {newRunsCount > 0 ? (
        <NewRunsButton count={newRunsCount} onClick={() => showNewRunsRef.current()} />
      ) : null}
      <RunsDisplayOptions sampleFilters={{ tasks: task.slug, rootOnly: "false" }} />
      <LinkButton
        variant="tertiary/small"
        to={bulkReplayPath}
        LeadingIcon={ListCheckedIcon}
        leadingIconClassName="-mx-1 text-bulkActions"
      >
        Bulk replay…
      </LinkButton>
      <LinkButton
        variant="tertiary/small"
        to={runsPath}
        LeadingIcon={RunsIcon}
        leadingIconClassName="text-runs"
      >
        Open in runs list
      </LinkButton>
    </>
  );

  const chart = (
    <div className="h-36 flex-none border-b border-grid-bright px-3 pb-2 pt-3">
      <ChartSyncProvider onZoom={zoomToTimeFilter}>
        <DeferredContent
          resolve={data.activity}
          retainKey={retainKey}
          fallback={<ChartSkeleton bars={42} />}
          errorElement={<ChartSkeleton bars={42} />}
        >
          {(activity) =>
            hasRuns(activity) ? (
              <RunsByStatusChart activity={activity} />
            ) : (
              <ChartBlankState icon={RunsIcon} message="No runs in this period" />
            )
          }
        </DeferredContent>
      </ChartSyncProvider>
    </div>
  );

  const skeleton = (
    <DetailTableTab tools={tools} actions={actions} above={chart}>
      <DetailTabLoading columns={RUN_SKELETON_COLUMNS} rows={12} />
    </DetailTableTab>
  );

  if (isPending) return skeleton;

  return (
    <DeferredContent
      resolve={data.runList}
      retainKey={retainKey}
      fallback={skeleton}
      errorElement={
        <DetailTableTab tools={tools} actions={actions} above={chart}>
          <DetailTabError
            title="Couldn't load runs"
            cause="The runs for this task didn't load. Try again, or open them in the runs list."
          />
        </DetailTableTab>
      }
    >
      {(list) =>
        list ? (
          <DetailTableTab
            tools={tools}
            actions={
              <>
                {actions}
                <ListPagination list={list} />
              </>
            }
            above={chart}
          >
            <TaskRunsList
              list={list}
              taskSlug={task.slug}
              onNewRunsCountChange={setNewRunsCount}
              showNewRunsRef={showNewRunsRef}
            />
          </DetailTableTab>
        ) : (
          skeleton
        )
      }
    </DeferredContent>
  );
}

function hasRuns(activity: TaskActivity) {
  return activity.data.some((point) =>
    activity.statuses.some((status) => Number(point[status] ?? 0) > 0)
  );
}

function RunsByStatusChart({ activity }: { activity: TaskActivity }) {
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

// ---------- Queue ----------

const QUEUE_TAB_REFRESH_MS = 10_000;

function TaskQueueTab({ data, isPending }: { data: TaskDetailPageData; isPending: boolean }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { value } = useSearchParams();
  const { queue, queueFullName } = data;

  // Only this tab polls: it mounts while Queue is open, and its counts and waiting runs go stale
  // as runs start and finish. Deferred content keeps what's on screen while the loader runs again.
  useAutoRevalidate({ interval: QUEUE_TAB_REFRESH_MS, onFocus: true });

  if (!queue || !queueFullName) {
    return (
      <DetailTabError
        title="Couldn't find this task's queue"
        cause="The queue for this version of the task wasn't found in this environment."
      />
    );
  }

  const queuedRunsPath = v3RunsPath(organization, project, environment, {
    queues: [queueFullName],
    statuses: ["PENDING"],
    period: data.queuedRunsPeriod,
    rootOnly: false,
  });

  const openInRunsList = (
    <LinkButton
      variant="tertiary/small"
      to={queuedRunsPath}
      LeadingIcon={RunsIcon}
      leadingIconClassName="text-runs"
    >
      Open in runs list
    </LinkButton>
  );
  const queuePath = data.queueMetricIds
    ? concurrencyQueuePath(organization, project, environment, { friendlyId: queue.id })
    : concurrencyPath(organization, project, environment);
  const tools = (
    <span className="flex items-center gap-1 text-xs text-text-dimmed">
      Waiting to start in
      <TextLink to={queuePath} className="font-mono">
        {queue.name}
      </TextLink>
      {queue.type === "task" ? "" : ", every task in the queue"}
    </span>
  );
  const nothingWaiting = (
    <DetailTableTab tools={tools} actions={openInRunsList}>
      <DetailTabEmpty
        title="Nothing waiting"
        description={
          queue.paused
            ? "No runs are queued. New runs will wait here until you resume the queue."
            : `No runs are queued in ${queue.name} right now.`
        }
      />
    </DetailTableTab>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <QueueSummary data={data} queue={queue} />
      {data.queueMetricIds ? (
        <div className="flex h-44 flex-none flex-col gap-1.5 border-b border-grid-bright px-3 pb-2 pt-2">
          <div className="flex items-center gap-3 text-xs text-text-dimmed">
            <TimeFilter defaultPeriod="7d" labelName="Queued" />
            <QueuePeriodStats
              ids={data.queueMetricIds}
              queueName={queueFullName}
              defaultPeriod="7d"
            />
          </div>
          <div className="min-h-0 flex-1">
            <QueueMetricChart
              query={`SELECT timeBucket() AS t, max(max_queued) AS queued\nFROM concurrency_metrics\nGROUP BY t\nORDER BY t`}
              fillGaps
              ids={data.queueMetricIds}
              timeRange={{
                period: value("period") ?? null,
                from: value("from") ?? null,
                to: value("to") ?? null,
              }}
              queueName={queueFullName}
              defaultPeriod="7d"
              series={[{ key: "queued", label: "Queued", color: QUEUE_METRIC_COLORS.queued }]}
            />
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {isPending ? (
          <DetailTableTab tools={tools} actions={openInRunsList}>
            <DetailTabLoading columns={RUN_SKELETON_COLUMNS} rows={6} />
          </DetailTableTab>
        ) : data.queuedRuns === null ? (
          // The queue is empty, so the loader didn't look for waiting runs.
          nothingWaiting
        ) : (
          <DeferredContent
            resolve={data.queuedRuns}
            fallback={
              <DetailTableTab tools={tools} actions={openInRunsList}>
                <DetailTabLoading columns={RUN_SKELETON_COLUMNS} rows={6} />
              </DetailTableTab>
            }
            errorElement={
              <DetailTabError
                title="Couldn't load queued runs"
                cause="Open them in the runs list instead."
              />
            }
          >
            {(list) =>
              list && list.runs.length === 0 ? (
                nothingWaiting
              ) : list ? (
                <DetailTableTab tools={tools} actions={openInRunsList}>
                  <TaskRunsTable
                    total={list.runs.length}
                    hasFilters={false}
                    filters={list.filters}
                    runs={list.runs}
                    isLoading={false}
                    variant="dimmed"
                    showTopBorder={false}
                    stickyHeader
                    disableAdjacentRows
                    enableSmartColumns={false}
                  />
                </DetailTableTab>
              ) : (
                <DetailTabError
                  title="Couldn't load queued runs"
                  cause="Open them in the runs list instead."
                />
              )
            }
          </DeferredContent>
        )}
      </div>
    </div>
  );
}

/**
 * What the queue's slots are counted against. A queue with a total limit is bounded by it across
 * all its concurrency keys, and its per-key limit caps each key within that; without a total it's
 * the queue's own limit, or the environment's when the queue sets none.
 */
function queueCapacity(queue: Queue, environmentConcurrencyLimit: number) {
  const { perKey, total } = queue.limits;
  if (total) {
    return {
      limit: total.current,
      running: total.running ?? queue.running,
      source: "total" as const,
      base: total.base,
      overridden: total.override !== null,
      // Only the per-key override's author is loaded, so a total override names no one.
      overrideNote: "The total limit is overridden",
      perKeyLimit: perKey.current,
    };
  }
  return {
    limit: perKey.current ?? environmentConcurrencyLimit,
    running: queue.running,
    source: perKey.current === null ? ("environment" as const) : ("queue" as const),
    base: perKey.base,
    overridden: perKey.override !== null,
    overrideNote: perKey.overriddenBy
      ? `Overridden by ${perKey.overriddenBy}`
      : "Overridden through the API",
    perKeyLimit: null,
  };
}

/** Most slots drawn one by one; above this the limit shows as a bar. */
const MAX_DRAWN_SLOTS = 40;
/** Waiting runs drawn as ticks, then "+N". */
const MAX_DRAWN_QUEUED = 40;

/**
 * The queue right now: its concurrency slots (running of limit), the runs waiting for one, and
 * the queue's own actions beside them.
 */
function QueueSummary({ data, queue }: { data: TaskDetailPageData; queue: Queue }) {
  const { limit, running, source, base, overridden, overrideNote, perKeyLimit } = queueCapacity(
    queue,
    data.environmentConcurrencyLimit
  );
  const queued = queue.queued;
  const oldestWaitMs =
    data.oldestQueuedAt !== null ? Math.max(0, data.loadedAt - data.oldestQueuedAt) : null;

  return (
    <div className="flex flex-none items-start justify-between gap-4 border-b border-grid-bright px-4 py-3.5">
      <div className="flex min-w-0 flex-wrap items-end gap-x-8 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-dimmed">
            <span className="tabular-nums text-text-bright">{formatNumber(running)}</span> of{" "}
            <span className="tabular-nums">{formatNumber(limit)}</span>{" "}
            {source === "environment" ? "(environment limit) " : ""}running
            {perKeyLimit !== null ? `, ${formatNumber(perKeyLimit)} per key` : ""}
            {overridden && base !== null ? (
              <SimpleTooltip
                button={
                  <span className="ml-1.5 text-warning">overridden from {formatNumber(base)}</span>
                }
                content={overrideNote}
                disableHoverableContent
              />
            ) : null}
            {queue.paused ? (
              <SimpleTooltip
                button={<span className="ml-1.5 text-warning">Paused</span>}
                content="No new runs start until the queue is resumed. Running runs carry on."
                disableHoverableContent
              />
            ) : null}
          </span>
          <ConcurrencySlots running={running} limit={limit} paused={queue.paused} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-dimmed">
            <span className="tabular-nums text-text-bright">{formatNumber(queued)}</span> queued
            {oldestWaitMs !== null && queued > 0
              ? `, oldest waiting ${formatDurationMilliseconds(oldestWaitMs, { style: "short", maxDecimalPoints: 0 })}`
              : ""}
          </span>
          <QueuedTicks queued={queued} />
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">
        <QueueOverrideConcurrencyButton
          queue={queue}
          environmentConcurrencyLimit={data.environmentConcurrencyLimit}
          trigger="button"
          disabled={!data.canWriteTasks}
        />
        <QueuePauseResumeButton
          queue={{ id: queue.id, name: queue.name, paused: queue.paused }}
          variant="secondary/small"
          disabled={!data.canWriteTasks}
        />
      </div>
    </div>
  );
}

function ConcurrencySlots({
  running,
  limit,
  paused,
}: {
  running: number;
  limit: number;
  paused: boolean;
}) {
  const label = `${running} of ${limit} concurrency slots in use`;
  if (limit <= 0) {
    return <div className="h-5 w-40 rounded-sm border border-grid-bright bg-background-deep" />;
  }
  if (limit > MAX_DRAWN_SLOTS) {
    const used = Math.min(1, running / limit);
    return (
      <div
        className="h-5 w-56 overflow-hidden rounded-sm border border-grid-bright bg-background-deep"
        aria-label={label}
        role="img"
      >
        <div
          className={cn("h-full", paused ? "bg-text-faint" : "bg-pending")}
          style={{ width: `${used * 100}%` }}
        />
      </div>
    );
  }
  return (
    <div className="flex gap-1" aria-label={label} role="img">
      {Array.from({ length: limit }).map((_, slot) => (
        <span
          key={slot}
          className={cn(
            "h-5 w-3.5 rounded-sm",
            slot < running
              ? paused
                ? "bg-text-faint"
                : "bg-pending"
              : "border border-grid-bright bg-background-deep"
          )}
        />
      ))}
    </div>
  );
}

function QueuedTicks({ queued }: { queued: number }) {
  if (queued === 0) {
    return <span className="flex h-5 items-center text-xs text-text-faint">Nothing waiting</span>;
  }
  const drawn = Math.min(queued, MAX_DRAWN_QUEUED);
  return (
    <div className="flex h-5 items-center gap-0.5" role="img" aria-label={`${queued} queued`}>
      {Array.from({ length: drawn }).map((_, run) => (
        <span key={run} className="h-full w-1.5 rounded-[1px] bg-text-faint" />
      ))}
      {queued > drawn ? (
        <span className="ml-1 text-xs tabular-nums text-text-dimmed">
          +{formatNumber(queued - drawn)}
        </span>
      ) : null}
    </div>
  );
}

// ---------- Rail ----------

function TaskRail({
  data,
  detailsExtra,
  afterDetails,
  extra,
}: {
  data: TaskDetailPageData;
  detailsExtra?: ReactNode;
  afterDetails?: ReactNode;
  extra?: ReactNode;
}) {
  const { task, queue } = data;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const kind = TRIGGER_SOURCE_ICON[task.triggerSource];
  const KindIcon = kind.icon;
  const showExportName = task.exportName && task.exportName !== task.slug;
  const queuePath = queue
    ? data.queueMetricIds
      ? concurrencyQueuePath(organization, project, environment, { friendlyId: queue.id })
      : concurrencyPath(organization, project, environment)
    : undefined;
  const capacity = queue ? queueCapacity(queue, data.environmentConcurrencyLimit) : null;

  return (
    <PropertyRail>
      <PropertyGroup title="Details">
        <DetailProperty label="Identifier">
          <CopyableText value={task.slug} className="font-mono text-xs" truncate />
        </DetailProperty>
        <PropertyPair>
          <DetailProperty label="Type">
            <span className="flex items-center gap-1.5">
              <KindIcon className={cn("size-4", kind.color)} />
              {taskTriggerSourceDescription(task.triggerSource)}
            </span>
          </DetailProperty>
          <DetailProperty label="Created">
            <DateTime date={task.firstSeenAt} />
          </DetailProperty>
        </PropertyPair>
        {task.description ? (
          <DetailProperty label="Description">
            <span className="whitespace-normal">{task.description}</span>
          </DetailProperty>
        ) : null}
        {detailsExtra}
      </PropertyGroup>
      {afterDetails}
      <PropertyGroup title="Execution">
        <DetailProperty label="Queue">
          {queue && queuePath ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <TextLink to={queuePath} className="truncate font-mono text-xs">
                {queue.name}
              </TextLink>
              {queue.paused ? <span className="text-xs text-warning">Paused</span> : null}
            </span>
          ) : (
            "–"
          )}
        </DetailProperty>
        <PropertyPair>
          <DetailProperty label="Concurrency">
            {capacity
              ? `${formatNumber(capacity.running)} of ${formatNumber(capacity.limit)} running`
              : "–"}
          </DetailProperty>
          <DetailProperty label="Machine">
            <MachineLabelCombo preset={task.machinePreset} />
          </DetailProperty>
          <DetailProperty label="Max duration">
            {task.maxDurationInSeconds
              ? formatDurationMilliseconds(task.maxDurationInSeconds * 1000, { style: "short" })
              : "–"}
          </DetailProperty>
          <DetailProperty label="TTL">{task.ttl ?? "–"}</DetailProperty>
        </PropertyPair>
        <DetailProperty label="Retry">
          <RetrySummary retry={task.retry} />
        </DetailProperty>
      </PropertyGroup>
      {extra}
      <PropertyGroup title="Source">
        <DetailProperty label="Version">
          {task.workerVersion ? <VersionLabel version={task.workerVersion} /> : "–"}
        </DetailProperty>
        <DetailProperty label="File path">
          <CopyableText value={task.filePath} className="font-mono text-xs" truncate />
        </DetailProperty>
        {showExportName ? (
          <DetailProperty label="Export name">
            <CopyableText value={task.exportName ?? ""} className="font-mono text-xs" truncate />
          </DetailProperty>
        ) : null}
        <DetailProperty label="Payload schema">
          {task.hasPayloadSchema ? "Yes" : "No"}
        </DetailProperty>
      </PropertyGroup>
    </PropertyRail>
  );
}

/** Retries shown as the waits between attempts, worked out the way the run engine does. */
function RetrySummary({ retry }: { retry: TaskDetail["retry"] }) {
  if (!retry || retry.maxAttempts === undefined) return <>–</>;
  if (retry.maxAttempts <= 1) return <>No retries (1 attempt)</>;

  const factor = retry.factor ?? 2;
  const min = retry.minTimeoutInMs ?? 1000;
  const max = retry.maxTimeoutInMs ?? 60000;
  const randomize = retry.randomize ?? true;
  const { shown, more } = retryWaits({
    maxAttempts: retry.maxAttempts,
    factor,
    min,
    max,
    limit: MAX_SHOWN_WAITS,
  });

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span>{retry.maxAttempts} attempts</span>
      <div
        className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-text-dimmed"
        title="Each attempt, and the wait before the next one"
      >
        {shown.map((wait, index) => (
          <span key={index} className="flex items-center gap-1">
            <AttemptMark n={index + 1} />
            <span className="tabular-nums">
              {formatDurationMilliseconds(wait, { style: "short", maxDecimalPoints: 1 })}
            </span>
          </span>
        ))}
        {more > 0 ? <span>… +{formatNumber(more)}</span> : <AttemptMark n={shown.length + 1} />}
      </div>
      <span className="text-xs text-text-dimmed">
        Backoff ×{factor}, {formatDurationMilliseconds(min, { style: "short" })} to{" "}
        {formatDurationMilliseconds(max, { style: "short" })}
        {randomize ? ", each wait up to 2× at random" : ""}
      </span>
    </div>
  );
}

const MAX_SHOWN_WAITS = 5;

function AttemptMark({ n }: { n: number }) {
  return (
    <span className="grid h-4 min-w-4 place-items-center rounded-sm border border-grid-bright bg-background-raised px-0.5 text-[0.625rem] tabular-nums text-text-bright">
      {n}
    </span>
  );
}

import { BookOpenIcon, PlusIcon } from "@heroicons/react/20/solid";
import { type ShouldRevalidateFunction, useFetcher, useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TypedAwait, typeddefer, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { statusColor } from "~/components/primitives/charts/statusColors";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header2 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Sheet, SheetContent } from "~/components/primitives/SheetV3";
import { Spinner } from "~/components/primitives/Spinner";
import { TextLink, textLinkClassName } from "~/components/primitives/TextLink";
import {
  QueueSidebarStats,
  type QueueLiveCounts,
  type QueueMetricIds,
} from "~/components/queues/QueueMetricCards";
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
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { useToast } from "~/components/primitives/Toast";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import {
  RunsListErrorState,
  RunsListErrorStateNoop,
} from "~/components/runs/v3/RunsListErrorState";
import { RunsListQueryError } from "~/services/runsRepository/runsRepository.server";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { ScheduleTypeCombo } from "~/components/runs/v3/ScheduleType";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { ScheduleInspector } from "~/components/schedules/ScheduleInspector";
import { ScheduleLimitActions } from "~/components/schedules/ScheduleLimitActions";
import { SchedulesUsageBar } from "~/components/schedules/SchedulesUsageBar";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { getRunColumnsForSelect } from "~/presenters/v3/runColumnsFromRequest.server";
import { RunsDisplayOptions } from "~/components/runs/v3/RunsDisplayOptions";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import {
  TaskDetailPresenter,
  type TaskActivity,
  type TaskDetail,
} from "~/presenters/v3/TaskDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { rbac } from "~/services/rbac.server";
import { requireUser } from "~/services/session.server";
import {
  docsPath,
  EnvironmentParamSchema,
  v3CreateBulkActionPath,
  v3EditSchedulePath,
  v3EnvironmentPath,
  v3NewSchedulePath,
  concurrencyQueuePath,
  v3RunsPath,
  v3SchedulePath,
  v3SchedulesAddOnPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";
import { formatNumber } from "~/utils/numberFormatter";
import { parseFiniteInt } from "~/utils/searchParams";
import { canAccessQueueMetricsUi } from "~/v3/canAccessQueueMetricsUi.server";
import { engine } from "~/v3/runEngine.server";
import type { loader as scheduleDetailLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam/route";
import type { loader as scheduleEditLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.edit.$scheduleParam/route";
import type { loader as scheduleNewLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { UpsertScheduleForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";
import { NewRunsButton, TaskRunsList } from "~/components/runs/v3/TaskRunsList";
import { taskAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import type { Handle } from "~/utils/handle";

export const handle: Handle = {
  agentPageContext: (data) => taskAgentPageContext(data),
};
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.task?.slug ?? params.taskParam ?? "Task",
  "Scheduled tasks",
]);

const ParamsSchema = EnvironmentParamSchema.extend({
  taskParam: z.string(),
});

export const shouldRevalidate: ShouldRevalidateFunction = ({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}) => {
  // Tab navigation does not change any loader data. Mutations and explicit refreshes still do.
  if (
    !formMethod &&
    currentUrl.pathname === nextUrl.pathname &&
    currentUrl.searchParams.get("tab") !== nextUrl.searchParams.get("tab")
  ) {
    const currentSearch = new URLSearchParams(currentUrl.search);
    const nextSearch = new URLSearchParams(nextUrl.search);
    currentSearch.delete("tab");
    nextSearch.delete("tab");
    if (currentSearch.toString() === nextSearch.toString()) return false;
  }

  return defaultShouldRevalidate;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam, taskParam } = ParamsSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  const auth = await rbac.authenticateSession(request, {
    userId,
    organizationId: project.organizationId,
  });
  const canManageBilling = auth.ok && auth.ability.can("manage", { type: "billing" });

  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const directionRaw = url.searchParams.get("direction") ?? undefined;
  const direction = directionRaw ? DirectionSchema.parse(directionRaw) : undefined;

  const [clickhouse, runsListClickhouse] = await Promise.all([
    clickhouseFactory.getClickhouseForOrganization(project.organizationId, "standard"),
    clickhouseFactory.getClickhouseForOrganization(project.organizationId, "runsList"),
  ]);

  const taskPresenter = new TaskDetailPresenter($replica, clickhouse);
  const task = await taskPresenter.findTask({
    environmentId: environment.id,
    environmentType: environment.type,
    taskSlug: taskParam,
    expectedTriggerSource: "SCHEDULED",
  });

  if (!task) throw new Response("Scheduled task not found", { status: 404 });

  // Live queue counts for the sidebar Queue property (flag on only; the property itself
  // is not rendered without them, so flag off = no extra reads and no UI change).
  let queueMetrics: { live: QueueLiveCounts; ids: QueueMetricIds } | null = null;
  if (task.queue && (await canAccessQueueMetricsUi({ request, userId, organizationSlug }))) {
    const queueName = task.queue.name;
    const [lengths, concurrency] = await Promise.all([
      engine.lengthOfQueues(environment, [queueName]),
      engine.currentConcurrencyOfQueues(environment, [queueName]),
    ]);
    queueMetrics = {
      live: {
        queued: lengths?.[queueName] ?? 0,
        running: concurrency?.[queueName] ?? 0,
      },
      ids: {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
      },
    };
  }

  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  const activity = taskPresenter
    .getActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      taskSlug: task.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies TaskActivity);

  const pageRaw = parseFiniteInt(url.searchParams.get("page"));
  const schedulesPage = pageRaw !== undefined && pageRaw > 0 ? pageRaw : 1;

  // Resolved synchronously — the bottom usage bar reads `limits` and
  // `canPurchaseSchedules` directly from it, and the limit-exceeded
  // intercept on the "Create schedule" button needs the same.
  const scheduleList = await new ScheduleListPresenter()
    .call({
      userId,
      projectId: project.id,
      environmentId: environment.id,
      tasks: [task.slug],
      page: schedulesPage,
      pageSize: 25,
      includeLastRun: true,
    })
    .catch(() => null);

  // Deleting the last schedule on a page must not leave an empty, unreachable page.
  if (scheduleList && schedulesPage > Math.max(1, scheduleList.totalPages)) {
    url.searchParams.set("page", String(Math.max(1, scheduleList.totalPages)));
    throw redirect(`${url.pathname}${url.search}`);
  }

  const runList = new NextRunListPresenter($replica, runsListClickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [task.slug],
      period,
      from,
      to,
      cursor,
      direction,
      includeHasAnyRuns: true,
      columns: getRunColumnsForSelect(request),
    })
    .catch((error) => {
      if (error instanceof RunsListQueryError) {
        throw error;
      }
      return null;
    });

  return typeddefer({
    task,
    activity,
    scheduleList,
    runList,
    queueMetrics,
    canManageBilling,
  });
};

export default function Page() {
  const { task, activity, scheduleList, runList, queueMetrics, canManageBilling } =
    useTypedLoaderData<typeof loader>();
  const zoomToTimeFilter = useZoomToTimeFilter();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const scheduledTasksListingPath = v3EnvironmentPath(organization, project, environment);
  const testPath = v3TestTaskPath(organization, project, environment, {
    taskIdentifier: task.slug,
  });
  const queuePath = task.queue
    ? concurrencyQueuePath(organization, project, environment, {
        friendlyId: task.queue.friendlyId,
      })
    : undefined;

  const filters: TaskRunListSearchFilters = useMemo(() => ({ tasks: [task.slug] }), [task.slug]);

  const search = useSearchParams();
  const openScheduleId = search.value("schedule");
  const openSchedule = useCallback(
    (friendlyId: string) => search.replace({ schedule: friendlyId }),
    [search]
  );
  const closeSchedule = useCallback(() => search.del("schedule"), [search]);

  const isCreatingSchedule = search.has("createSchedule");
  const openCreateSchedule = useCallback(() => search.replace({ createSchedule: "1" }), [search]);
  const closeCreateSchedule = useCallback(() => search.del("createSchedule"), [search]);

  const requestedTab = search.value("tab") ?? (search.has("page") ? "schedules" : "runs");
  const mainTab = requestedTab === "schedules" ? "schedules" : "runs";
  const setMainTab = (tab: "runs" | "schedules") => search.replace({ tab });

  const sortedSchedules = useMemo(() => {
    if (!scheduleList) return [];
    // DECLARATIVE first; createdAt-desc within each type (stable sort).
    return [...scheduleList.schedules].sort((a, b) => {
      if (a.type === b.type) return 0;
      return a.type === "DECLARATIVE" ? -1 : 1;
    });
  }, [scheduleList]);

  // Schedules add-on / quota state — drives the bottom usage bar and the
  // "Create schedule" button's limit-exceeded intercept.
  const plan = useCurrentPlan();
  const limits = scheduleList?.limits;
  const requiresUpgrade =
    !!plan?.v3Subscription?.plan &&
    !!limits &&
    limits.used >= plan.v3Subscription.plan.limits.schedules.number &&
    !plan.v3Subscription.plan.limits.schedules.canExceed;
  const canUpgrade =
    !!plan?.v3Subscription?.plan && !plan.v3Subscription.plan.limits.schedules.canExceed;
  const isAtLimit = !!limits && limits.used >= limits.limit;

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
          backButton={{ to: scheduledTasksListingPath, text: "Tasks" }}
          title={
            <span className="flex items-center gap-1">
              <ClockIcon className="size-4.5 text-schedules" />
              <span>{task.slug}</span>
            </span>
          }
        />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="scheduled-task-main" min="300px">
            <div className="grid h-full grid-rows-[auto_1fr_auto] overflow-hidden">
              <div className="flex min-h-10 items-center gap-2 border-b border-grid-dimmed bg-background-bright px-2 py-2">
                <TimeFilter defaultPeriod="7d" labelName="Runs" />
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  <LinkButton
                    variant="secondary/small"
                    to={v3RunsPath(organization, project, environment, filters)}
                    LeadingIcon={RunsIcon}
                    // -7px halves the icon's default 6px of space on each side.
                    leadingIconClassName="-mx-[7px]"
                  >
                    View all runs
                  </LinkButton>
                  <LinkButton
                    variant="secondary/small"
                    to={v3CreateBulkActionPath(
                      organization,
                      project,
                      environment,
                      filters,
                      "filter",
                      "replay"
                    )}
                    LeadingIcon={ListCheckedIcon}
                    leadingIconClassName="-mx-1"
                  >
                    Bulk replay…
                  </LinkButton>
                  <CreateScheduleButton
                    isAtLimit={isAtLimit}
                    limits={limits}
                    canUpgrade={canUpgrade}
                    canPurchaseSchedules={scheduleList?.canPurchaseSchedules ?? false}
                    canManageBilling={canManageBilling}
                    extraSchedules={scheduleList?.extraSchedules ?? 0}
                    maxScheduleQuota={scheduleList?.maxScheduleQuota ?? 0}
                    planScheduleLimit={scheduleList?.planScheduleLimit ?? 0}
                    schedulePricing={scheduleList?.schedulePricing ?? null}
                    onCreate={openCreateSchedule}
                    disabled={isCreatingSchedule}
                  />
                </div>
              </div>

              <ResizablePanelGroup orientation="vertical" className="max-h-full">
                {/* Activity chart */}
                <ResizablePanel id="scheduled-task-activity" min="220px" default="320px">
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

                <ResizableHandle id="scheduled-task-activity-handle" />

                {/* Runs and schedules tables */}
                <ResizablePanel id="scheduled-task-content" min="160px">
                  <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
                    {/* -mt-px absorbs the spare pixel below the handle's rule, centring the tabs. */}
                    <TabContainer variant="title" className="-mt-px justify-between pl-2.5 pr-1.5">
                      <div className="flex items-stretch gap-x-6">
                        <TabButton
                          isActive={mainTab === "runs"}
                          aria-pressed={mainTab === "runs"}
                          layoutId="scheduled-task-main-tabs"
                          variant="title"
                          size="small"
                          onClick={() => setMainTab("runs")}
                        >
                          Runs
                        </TabButton>
                        <TabButton
                          isActive={mainTab === "schedules"}
                          aria-pressed={mainTab === "schedules"}
                          layoutId="scheduled-task-main-tabs"
                          variant="title"
                          size="small"
                          onClick={() => setMainTab("schedules")}
                        >
                          Schedules
                          {scheduleList ? ` (${formatNumber(scheduleList.totalCount)})` : ""}
                        </TabButton>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {mainTab === "runs" ? (
                          <>
                            {newRunsCount > 0 ? (
                              <NewRunsButton
                                count={newRunsCount}
                                onClick={() => showNewRunsRef.current()}
                              />
                            ) : null}
                            <RunsDisplayOptions
                              sampleFilters={{ tasks: task.slug, rootOnly: "false" }}
                            />
                            <Suspense fallback={null}>
                              <TypedAwait
                                resolve={runList}
                                errorElement={<RunsListErrorStateNoop />}
                              >
                                {(list) => (list ? <ListPagination list={list} /> : null)}
                              </TypedAwait>
                            </Suspense>
                          </>
                        ) : scheduleList ? (
                          <PaginationControls
                            currentPage={scheduleList.currentPage}
                            totalPages={scheduleList.totalPages}
                            showPageNumbers={false}
                          />
                        ) : null}
                      </div>
                    </TabContainer>
                    <div className="min-h-0 overflow-hidden">
                      {mainTab === "runs" ? (
                        <Suspense fallback={<TableLoading />}>
                          <TypedAwait resolve={runList} errorElement={<RunsListErrorState />}>
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
                      ) : !scheduleList ? (
                        <TableLoading />
                      ) : scheduleList.totalCount === 0 ? (
                        <div className="h-full overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
                          <div className="max-w-xl">
                            <NoSchedulesAttachedPanel />
                          </div>
                        </div>
                      ) : (
                        <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
                          <SchedulesTable
                            schedules={sortedSchedules}
                            onSelectSchedule={openSchedule}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>

              {/* Schedules usage bar — pinned to the bottom of the main panel
                  via the grid-rows-[auto_1fr_auto] above. */}
              {scheduleList ? (
                <SchedulesUsageBar
                  limits={scheduleList.limits}
                  requiresUpgrade={requiresUpgrade}
                  canUpgrade={canUpgrade}
                  canPurchaseSchedules={scheduleList.canPurchaseSchedules}
                  canManageBilling={canManageBilling}
                  extraSchedules={scheduleList.extraSchedules}
                  maxScheduleQuota={scheduleList.maxScheduleQuota}
                  planScheduleLimit={scheduleList.planScheduleLimit}
                  schedulePricing={scheduleList.schedulePricing}
                />
              ) : null}
            </div>
          </ResizablePanel>

          <ResizableHandle id="scheduled-task-detail-handle" />
          <ResizablePanel
            id="scheduled-task-detail"
            min="280px"
            default="380px"
            max="80%"
            isStaticAtRest
          >
            <ScheduledTaskDetailSidebar
              task={task}
              testPath={testPath}
              scheduleList={scheduleList}
              onViewSchedules={() => setMainTab("schedules")}
              queuePath={queuePath}
              queueMetrics={queueMetrics}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>

      <ScheduleSheet
        openScheduleId={openScheduleId}
        organization={organization}
        project={project}
        environment={environment}
        onClose={closeSchedule}
      />

      <CreateScheduleSheet
        open={isCreatingSchedule}
        organization={organization}
        project={project}
        environment={environment}
        defaultTaskIdentifier={task.slug}
        onClose={closeCreateSchedule}
      />
    </PageContainer>
  );
}

/**
 * "Create schedule" button with a limit-exceeded intercept. When the project
 * is already at its schedules limit, clicking opens a dialog explaining the
 * limit and offering Purchase / Upgrade / Request, mirroring the behavior
 * that lived on the (now-removed) standalone Schedules listing page.
 */
function CreateScheduleButton({
  isAtLimit,
  limits,
  canUpgrade,
  canPurchaseSchedules,
  canManageBilling,
  extraSchedules,
  maxScheduleQuota,
  planScheduleLimit,
  schedulePricing,
  onCreate,
  disabled,
}: {
  isAtLimit: boolean;
  limits: { used: number; limit: number } | undefined;
  canUpgrade: boolean;
  canPurchaseSchedules: boolean;
  canManageBilling: boolean;
  extraSchedules: number;
  maxScheduleQuota: number;
  planScheduleLimit: number;
  schedulePricing: { stepSize: number; centsPerStep: number } | null;
  onCreate: () => void;
  disabled?: boolean;
}) {
  const organization = useOrganization();
  const addOnPath = v3SchedulesAddOnPath(organization);

  if (isAtLimit && limits) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button
            LeadingIcon={PlusIcon}
            leadingIconClassName="-mx-1"
            variant="primary/small"
            disabled={disabled}
          >
            Create schedule
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>You've exceeded your limit</DialogHeader>
          <DialogDescription>
            You've used {limits.used}/{limits.limit} of your schedules.
          </DialogDescription>
          <DialogFooter>
            <ScheduleLimitActions
              actionPath={addOnPath}
              canPurchaseSchedules={canPurchaseSchedules}
              canManageBilling={canManageBilling}
              schedulePricing={schedulePricing}
              extraSchedules={extraSchedules}
              limits={limits}
              maxScheduleQuota={maxScheduleQuota}
              planScheduleLimit={planScheduleLimit}
              canUpgrade={canUpgrade}
              organization={organization}
              variant="dialog"
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Button
      variant="primary/small"
      LeadingIcon={PlusIcon}
      leadingIconClassName="-mx-1"
      onClick={onCreate}
      disabled={disabled}
    >
      Create schedule
    </Button>
  );
}

function CreateScheduleSheet({
  open,
  organization,
  project,
  environment,
  defaultTaskIdentifier,
  onClose,
}: {
  open: boolean;
  organization: ReturnType<typeof useOrganization>;
  project: ReturnType<typeof useProject>;
  environment: ReturnType<typeof useEnvironment>;
  defaultTaskIdentifier: string;
  onClose: () => void;
}) {
  const fetcher = useTypedFetcher<typeof scheduleNewLoader>();
  const loadScheduleForm = fetcher.load;
  // Embedded create — stays on this page via `_format=json`.
  const createFetcher = useFetcher<{ ok: boolean; message?: string }>();
  const toast = useToast();
  const revalidator = useRevalidator();
  // `useRevalidator()` and `onClose` change identity every render — guard
  // against the dep churn so we only handle each response once.
  const handledCreateRef = useRef<unknown>(null);
  const newPath = v3NewSchedulePath(organization, project, environment);

  useEffect(() => {
    if (open) loadScheduleForm(newPath);
  }, [open, newPath, loadScheduleForm]);

  // Toast + close + revalidate so the new schedule appears.
  useEffect(() => {
    const data = createFetcher.data;
    if (createFetcher.state !== "idle" || !data) return;
    if (handledCreateRef.current === data) return;
    handledCreateRef.current = data;
    if (data.ok) {
      toast.success(data.message ?? "Schedule created");
      revalidator.revalidate();
      onClose();
    } else if (data.message) {
      toast.error(data.message);
    }
  }, [createFetcher.state, createFetcher.data, toast, revalidator, onClose]);

  const data = fetcher.data;
  const isLoading = fetcher.state === "loading" || (open && !data);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-[480px] max-w-none border-l border-grid-dimmed bg-background-bright p-0 sm:max-w-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {isLoading || !data ? (
          <TableLoading />
        ) : (
          <UpsertScheduleForm
            schedule={data.schedule}
            possibleTasks={data.possibleTasks}
            possibleEnvironments={data.possibleEnvironments}
            possibleTimezones={data.possibleTimezones}
            newSchedulePolicy={data.newSchedulePolicy}
            showGenerateField={data.showGenerateField}
            defaultTaskIdentifier={defaultTaskIdentifier}
            onCancel={onClose}
            submitFetcher={createFetcher}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function ScheduleSheet({
  openScheduleId,
  organization,
  project,
  environment,
  onClose,
}: {
  openScheduleId: string | undefined;
  organization: ReturnType<typeof useOrganization>;
  project: ReturnType<typeof useProject>;
  environment: ReturnType<typeof useEnvironment>;
  onClose: () => void;
}) {
  const detailFetcher = useTypedFetcher<typeof scheduleDetailLoader>();
  const loadScheduleDetail = detailFetcher.load;
  const editFetcher = useTypedFetcher<typeof scheduleEditLoader>();
  const loadScheduleEditor = editFetcher.load;
  // Embedded enable/disable — stays in the sheet via `_format=json`.
  const activeToggleFetcher = useFetcher<{ ok: boolean; active?: boolean; message?: string }>();
  // Embedded update submission — same idea.
  const updateFetcher = useFetcher<{ ok: boolean; message?: string }>();
  // Embedded delete submission — same idea.
  const deleteFetcher = useFetcher<{ ok: boolean; message?: string }>();
  const toast = useToast();
  const revalidator = useRevalidator();
  // Dedupe response handling against unstable deps (revalidator/onClose).
  const handledToggleRef = useRef<unknown>(null);
  const handledUpdateRef = useRef<unknown>(null);
  const handledDeleteRef = useRef<unknown>(null);
  const [mode, setMode] = useState<"inspect" | "edit">("inspect");

  const detailPath = openScheduleId
    ? v3SchedulePath(organization, project, environment, { friendlyId: openScheduleId })
    : undefined;
  const editPath = openScheduleId
    ? v3EditSchedulePath(organization, project, environment, { friendlyId: openScheduleId })
    : undefined;

  // Always reopen in inspect mode.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
    setMode("inspect");
  }, [openScheduleId]);

  useEffect(() => {
    if (detailPath) loadScheduleDetail(detailPath);
  }, [detailPath, loadScheduleDetail]);

  useEffect(() => {
    if (mode === "edit" && editPath) loadScheduleEditor(editPath);
  }, [mode, editPath, loadScheduleEditor]);

  // Reload inspector data so Enable/Disable label flips; revalidate the
  // route loader so the sidebar's list/Overview stay in sync; toast on error.
  useEffect(() => {
    const data = activeToggleFetcher.data;
    if (activeToggleFetcher.state !== "idle" || !data) return;
    if (handledToggleRef.current === data) return;
    handledToggleRef.current = data;
    if (data.ok) {
      if (detailPath) loadScheduleDetail(detailPath);
      revalidator.revalidate();
    } else if (data.message) {
      toast.error(data.message);
    }
  }, [
    activeToggleFetcher.state,
    activeToggleFetcher.data,
    detailPath,
    toast,
    revalidator,
    loadScheduleDetail,
  ]);

  // Toast + back to inspect + reload + revalidate so both the inspector
  // and the sidebar reflect the update.
  useEffect(() => {
    const data = updateFetcher.data;
    if (updateFetcher.state !== "idle" || !data) return;
    if (handledUpdateRef.current === data) return;
    handledUpdateRef.current = data;
    if (data.ok) {
      toast.success(data.message ?? "Schedule updated");
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setMode("inspect");
      if (detailPath) loadScheduleDetail(detailPath);
      revalidator.revalidate();
    } else if (data.message) {
      toast.error(data.message);
    }
  }, [updateFetcher.state, updateFetcher.data, detailPath, toast, revalidator, loadScheduleDetail]);

  // Toast + close + revalidate so the deleted row disappears.
  useEffect(() => {
    const data = deleteFetcher.data;
    if (deleteFetcher.state !== "idle" || !data) return;
    if (handledDeleteRef.current === data) return;
    handledDeleteRef.current = data;
    if (data.ok) {
      toast.success(data.message ?? "Schedule deleted");
      revalidator.revalidate();
      onClose();
    } else if (data.message) {
      toast.error(data.message);
    }
  }, [deleteFetcher.state, deleteFetcher.data, toast, revalidator, onClose]);

  const schedule = detailFetcher.data?.schedule;
  // Treat stale data (previous schedule still in fetcher cache after the
  // user clicked a different row) as loading — otherwise we briefly flash
  // the previous schedule's content while the new fetch is in flight.
  const isStaleSchedule = !!schedule && !!openScheduleId && schedule.friendlyId !== openScheduleId;
  // Only show the loading spinner when we actually lack good data —
  // background reloads (e.g. after enable/disable) keep the inspector
  // visible with its current values until the fresh data arrives.
  const isDetailLoading = isStaleSchedule || (!!openScheduleId && detailFetcher.data === undefined);
  // Distinct from loading: the loader has resolved and the schedule is
  // genuinely gone (returned `null`, e.g. deleted externally).
  const isScheduleMissing =
    !!openScheduleId && !isDetailLoading && detailFetcher.data?.schedule === null;
  const editData = editFetcher.data;
  // Mirror the detail-fetcher staleness check so the edit form doesn't
  // briefly flash a previously-edited schedule's data on the first render
  // after switching schedules.
  const isStaleEditData =
    !!editData?.schedule && !!openScheduleId && editData.schedule.friendlyId !== openScheduleId;
  const isEditLoading =
    mode === "edit" && (editFetcher.state === "loading" || !editData || isStaleEditData);

  return (
    <Sheet open={!!openScheduleId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-[480px] max-w-none border-l border-grid-dimmed bg-background-bright p-0 sm:max-w-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {mode === "edit" ? (
          isEditLoading || !editData ? (
            <TableLoading />
          ) : (
            <UpsertScheduleForm
              schedule={editData.schedule}
              possibleTasks={editData.possibleTasks}
              possibleEnvironments={editData.possibleEnvironments}
              possibleTimezones={editData.possibleTimezones}
              showGenerateField={editData.showGenerateField}
              onCancel={() => setMode("inspect")}
              submitFetcher={updateFetcher}
            />
          )
        ) : isDetailLoading ? (
          <TableLoading />
        ) : isScheduleMissing ? (
          <ScheduleMissingPanel onClose={onClose} />
        ) : schedule ? (
          <ScheduleInspector
            schedule={schedule}
            actionPath={detailPath}
            onEdit={() => setMode("edit")}
            activeToggleFetcher={activeToggleFetcher}
            deleteFetcher={deleteFetcher}
          />
        ) : (
          <TableLoading />
        )}
      </SheetContent>
    </Sheet>
  );
}

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;

function ScheduledTaskDetailSidebar({
  task,
  testPath,
  scheduleList,
  onViewSchedules,
  queuePath,
  queueMetrics,
}: {
  task: TaskDetail;
  testPath: string;
  onViewSchedules: () => void;
  queuePath: string | undefined;
  queueMetrics: { live: QueueLiveCounts; ids: QueueMetricIds } | null;
} & Pick<LoaderData, "scheduleList">) {
  const scheduleCount = scheduleList?.totalCount ?? 0;
  // Only describe a single schedule when it is the task's only one.
  const onlySchedule = scheduleCount === 1 ? scheduleList?.schedules[0] : undefined;

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-background-bright">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden border-b border-grid-bright py-2 pl-3 pr-1.5">
        <Header2 className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          <ClockIcon className="size-4.5 shrink-0 text-schedules" />
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
          Test schedule
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
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={task.createdAt} />
            </Property.Value>
          </Property.Item>
          {onlySchedule ? (
            <>
              <Property.Item>
                <Property.Label>Schedule ID</Property.Label>
                <Property.Value>
                  <CopyableText value={onlySchedule.friendlyId} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Cron</Property.Label>
                <Property.Value>
                  <div className="space-y-2">
                    <InlineCode variant="extra-small">{onlySchedule.cron}</InlineCode>
                    <Paragraph variant="small">{onlySchedule.cronDescription}</Paragraph>
                  </div>
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Timezone</Property.Label>
                <Property.Value>{onlySchedule.timezone}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Next run</Property.Label>
                <Property.Value>
                  <NextRun schedule={onlySchedule} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Last run</Property.Label>
                <Property.Value>
                  {onlySchedule.lastRun ? (
                    <RelativeDateTime date={onlySchedule.lastRun} />
                  ) : (
                    <span className="text-text-dimmed">Never</span>
                  )}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Status</Property.Label>
                <Property.Value>
                  <EnabledStatus enabled={onlySchedule.active} />
                </Property.Value>
              </Property.Item>
            </>
          ) : scheduleCount > 1 ? (
            <Property.Item>
              <Property.Label>Schedules</Property.Label>
              <Property.Value>
                <div className="flex flex-col items-start gap-0.5">
                  <span>{formatNumber(scheduleCount)} schedules</span>
                  <button type="button" className={textLinkClassName()} onClick={onViewSchedules}>
                    View schedules
                  </button>
                </div>
              </Property.Value>
            </Property.Item>
          ) : null}
          {queueMetrics && task.queue && queuePath ? (
            <Property.Item>
              <Property.Label>Queue</Property.Label>
              <Property.Value>
                <div className="flex flex-col gap-0.5">
                  <TextLink to={queuePath}>{task.queue.name}</TextLink>
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Concurrency: {task.queue.concurrencyLimit ?? "Unlimited"}
                    {task.queue.paused ? " · Paused" : ""}
                  </Paragraph>
                  <QueueSidebarStats
                    live={queueMetrics.live}
                    ids={queueMetrics.ids}
                    queueName={task.queue.name}
                    defaultPeriod="7d"
                  />
                </div>
              </Property.Value>
            </Property.Item>
          ) : null}
        </Property.Table>
        {scheduleList && scheduleCount === 0 ? (
          <div className="mt-4">
            <NoSchedulesAttachedPanel />
          </div>
        ) : null}
      </div>
    </div>
  );
}

type ScheduleRow = NonNullable<LoaderData["scheduleList"]>["schedules"][number];

function NextRun({ schedule }: { schedule: Pick<ScheduleRow, "active" | "nextRunEffectiveAt"> }) {
  if (!schedule.active) {
    return <span className="text-text-dimmed">–</span>;
  }

  return (
    <span className="inline-flex flex-col whitespace-nowrap">
      <DateTime date={schedule.nextRunEffectiveAt} />
      <span className="text-text-dimmed">
        <RelativeDateTime date={schedule.nextRunEffectiveAt} capitalize={false} />
      </span>
    </span>
  );
}

function SchedulesTable({
  schedules,
  onSelectSchedule,
}: {
  schedules: ScheduleRow[];
  onSelectSchedule: (friendlyId: string) => void;
}) {
  if (schedules.length === 0) {
    return (
      <Table variant="dimmed" showTopBorder={false}>
        <TableBody>
          <TableBlankRow colSpan={7}>
            <Paragraph variant="small" className="flex items-center justify-center">
              No schedules attached to this task yet.
            </Paragraph>
          </TableBlankRow>
        </TableBody>
      </Table>
    );
  }

  return (
    <Table variant="dimmed" showTopBorder={false} stickyHeader>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Schedule</TableHeaderCell>
          <TableHeaderCell>Cron</TableHeaderCell>
          <TableHeaderCell>Window</TableHeaderCell>
          <TableHeaderCell>External ID</TableHeaderCell>
          <TableHeaderCell>Next run</TableHeaderCell>
          <TableHeaderCell>Last run</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.map((schedule) => {
          const open = () => onSelectSchedule(schedule.friendlyId);
          return (
            <TableRow key={schedule.id} className="group">
              <TableCell onClick={open} isTabbableCell>
                <span className="inline-flex flex-col gap-0.5">
                  <TruncatedText
                    text={schedule.friendlyId}
                    className="max-w-32 font-mono text-xs"
                  />
                  <ScheduleTypeCombo type={schedule.type} className="text-xs text-text-dimmed" />
                </span>
              </TableCell>
              <TableCell onClick={open}>
                <span className="inline-flex flex-col">
                  <span className="font-mono text-xs">{schedule.cron}</span>
                  <span className="text-xs text-text-dimmed">{schedule.timezone}</span>
                </span>
              </TableCell>
              <TableCell onClick={open}>
                <span className="text-xs">{schedule.window ?? "–"}</span>
              </TableCell>
              <TableCell onClick={open}>
                {schedule.externalId ? (
                  <span className="font-mono text-xs">{schedule.externalId}</span>
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </TableCell>
              <TableCell onClick={open}>
                <NextRun schedule={schedule} />
              </TableCell>
              <TableCell onClick={open}>
                {schedule.lastRun ? (
                  <RelativeDateTime date={schedule.lastRun} />
                ) : (
                  <span className="text-text-dimmed">Never</span>
                )}
              </TableCell>
              <TableCell onClick={open}>
                <EnabledStatus enabled={schedule.active} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
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

function NoSchedulesAttachedPanel() {
  return (
    <InfoPanel
      title="No schedules attached"
      icon={ClockIcon}
      iconClassName="text-schedules"
      panelClassName="max-w-full"
      accessory={
        <LinkButton
          to={docsPath("v3/tasks-scheduled")}
          variant="docs/small"
          LeadingIcon={BookOpenIcon}
        >
          Read the docs
        </LinkButton>
      }
    >
      <Paragraph spacing variant="small">
        Scheduled tasks only run automatically when a schedule is attached. There are two types:
      </Paragraph>
      <Paragraph spacing variant="small">
        <span className="font-medium text-text-bright">Declarative</span> — defined directly on your{" "}
        <InlineCode>schedules.task</InlineCode> and synced when you run dev or deploy.
      </Paragraph>
      <Paragraph variant="small">
        <span className="font-medium text-text-bright">Imperative</span> — created dynamically from
        the dashboard or via the SDK with <InlineCode>schedules.create()</InlineCode>.
      </Paragraph>
    </InfoPanel>
  );
}

function TableLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

function ScheduleMissingPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background-bright p-6 text-center">
      <Paragraph variant="small" className="text-text-bright">
        This schedule no longer exists.
      </Paragraph>
      <Button variant="secondary/small" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

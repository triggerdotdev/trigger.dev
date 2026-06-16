import { type MetaFunction, useFetcher, useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TypedAwait, typeddefer, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BookOpenIcon, PlusIcon } from "@heroicons/react/20/solid";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { ScheduleLimitActions } from "~/components/schedules/ScheduleLimitActions";
import { SchedulesUsageBar } from "~/components/schedules/SchedulesUsageBar";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { InlineCode } from "~/components/code/InlineCode";
import { CopyableText } from "~/components/primitives/CopyableText";
import { PaginationControls } from "~/components/primitives/Pagination";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { useToast } from "~/components/primitives/Toast";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import * as Property from "~/components/primitives/PropertyTable";
import { Sheet, SheetContent } from "~/components/primitives/SheetV3";
import { ScheduleInspector } from "~/components/schedules/ScheduleInspector";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  type TableVariant,
} from "~/components/primitives/Table";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import type { TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { ScheduleTypeIcon, scheduleTypeName } from "~/components/runs/v3/ScheduleType";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import type { loader as scheduleDetailLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam/route";
import type { loader as scheduleEditLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.edit.$scheduleParam/route";
import type { loader as scheduleNewLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";
import { UpsertScheduleForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";
import {
  TaskDetailPresenter,
  type TaskActivity,
  type TaskDetail,
} from "~/presenters/v3/TaskDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import {
  docsPath,
  EnvironmentParamSchema,
  v3BillingPath,
  v3CreateBulkActionPath,
  v3EditSchedulePath,
  v3EnvironmentPath,
  v3NewSchedulePath,
  v3RunsPath,
  v3SchedulePath,
  v3SchedulesAddOnPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const slug = (data as { task?: TaskDetail | null } | undefined)?.task?.slug;
  return [
    { title: slug ? `${slug} | Scheduled tasks | Trigger.dev` : "Scheduled task | Trigger.dev" },
  ];
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

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );

  const taskPresenter = new TaskDetailPresenter($replica, clickhouse);
  const task = await taskPresenter.findTask({
    environmentId: environment.id,
    environmentType: environment.type,
    taskSlug: taskParam,
    expectedTriggerSource: "SCHEDULED",
  });

  if (!task) throw new Response("Scheduled task not found", { status: 404 });

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
    .catch(() => ({ data: [], statuses: [] } satisfies TaskActivity));

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
    })
    .catch(() => null);

  const runList = new NextRunListPresenter($replica, clickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [task.slug],
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
    scheduleList,
    runList,
  });
};

export default function Page() {
  const { task, activity, scheduleList, runList } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const scheduledTasksListingPath = v3EnvironmentPath(organization, project, environment);
  const testPath = v3TestTaskPath(organization, project, environment, {
    taskIdentifier: task.slug,
  });

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
              {/* Top bar — title on the left; actions + TimeFilter + pagination on the right.
                  h-10 matches the right-hand sidebar header height. */}
              <div className="flex min-h-10 items-center gap-2 border-b border-grid-dimmed bg-background-bright py-2 pl-3 pr-2">
                <Header2>Runs</Header2>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                  <CreateScheduleButton
                    isAtLimit={isAtLimit}
                    limits={limits}
                    canUpgrade={canUpgrade}
                    canPurchaseSchedules={scheduleList?.canPurchaseSchedules ?? false}
                    extraSchedules={scheduleList?.extraSchedules ?? 0}
                    maxScheduleQuota={scheduleList?.maxScheduleQuota ?? 0}
                    planScheduleLimit={scheduleList?.planScheduleLimit ?? 0}
                    schedulePricing={scheduleList?.schedulePricing ?? null}
                    onCreate={openCreateSchedule}
                    disabled={isCreatingSchedule}
                  />
                  <TimeFilter defaultPeriod="7d" labelName="Runs" />
                  <LinkButton
                    variant="secondary/small"
                    to={v3RunsPath(organization, project, environment, filters)}
                    LeadingIcon={RunsIcon}
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
                  <Suspense fallback={null}>
                    <TypedAwait resolve={runList} errorElement={null}>
                      {(list) => (list ? <ListPagination list={list} /> : null)}
                    </TypedAwait>
                  </Suspense>
                </div>
              </div>

              <ResizablePanelGroup orientation="vertical" className="max-h-full">
                {/* Activity chart */}
                <ResizablePanel id="scheduled-task-activity" min="220px" default="320px">
                  <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background p-2">
                    <Card className="h-full overflow-hidden px-0 pb-2 pt-3">
                      <Card.Header>Runs by status</Card.Header>
                      <div className="min-h-0 flex-1 px-2">
                        <Suspense fallback={<ActivityChartSkeleton />}>
                          <TypedAwait resolve={activity} errorElement={<ActivityChartSkeleton />}>
                            {(result) => <ActivityChart activity={result} />}
                          </TypedAwait>
                        </Suspense>
                      </div>
                    </Card>
                  </div>
                </ResizablePanel>

                <ResizableHandle id="scheduled-task-activity-handle" />

                {/* Runs table */}
                <ResizablePanel id="scheduled-task-content" min="160px">
                  <div className="h-full overflow-hidden">
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
              onSelectSchedule={openSchedule}
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
  // Embedded create — stays on this page via `_format=json`.
  const createFetcher = useFetcher<{ ok: boolean; message?: string }>();
  const toast = useToast();
  const revalidator = useRevalidator();
  // `useRevalidator()` and `onClose` change identity every render — guard
  // against the dep churn so we only handle each response once.
  const handledCreateRef = useRef<unknown>(null);
  const newPath = v3NewSchedulePath(organization, project, environment);

  useEffect(() => {
    if (open) fetcher.load(newPath);
  }, [open, newPath]);

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
  const editFetcher = useTypedFetcher<typeof scheduleEditLoader>();
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
    setMode("inspect");
  }, [openScheduleId]);

  useEffect(() => {
    if (detailPath) detailFetcher.load(detailPath);
  }, [detailPath]);

  useEffect(() => {
    if (mode === "edit" && editPath) editFetcher.load(editPath);
  }, [mode, editPath]);

  // Reload inspector data so Enable/Disable label flips; toast on error.
  useEffect(() => {
    const data = activeToggleFetcher.data;
    if (activeToggleFetcher.state !== "idle" || !data) return;
    if (handledToggleRef.current === data) return;
    handledToggleRef.current = data;
    if (data.ok) {
      if (detailPath) detailFetcher.load(detailPath);
    } else if (data.message) {
      toast.error(data.message);
    }
  }, [activeToggleFetcher.state, activeToggleFetcher.data, detailPath, toast]);

  // Toast + back to inspect + reload so the inspector reflects the update.
  useEffect(() => {
    const data = updateFetcher.data;
    if (updateFetcher.state !== "idle" || !data) return;
    if (handledUpdateRef.current === data) return;
    handledUpdateRef.current = data;
    if (data.ok) {
      toast.success(data.message ?? "Schedule updated");
      setMode("inspect");
      if (detailPath) detailFetcher.load(detailPath);
    } else if (data.message) {
      toast.error(data.message);
    }
  }, [updateFetcher.state, updateFetcher.data, detailPath, toast]);

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
  const isDetailLoading =
    detailFetcher.state === "loading" ||
    isStaleSchedule ||
    (!!openScheduleId && schedule === undefined);
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
  onSelectSchedule,
}: { task: TaskDetail; testPath: string; onSelectSchedule: (friendlyId: string) => void } & Pick<
  LoaderData,
  "scheduleList"
>) {
  const sortedSchedules = useMemo(() => {
    if (!scheduleList) return [];
    // DECLARATIVE first; createdAt-desc within each type (stable sort).
    return [...scheduleList.schedules].sort((a, b) => {
      if (a.type === b.type) return 0;
      return a.type === "DECLARATIVE" ? -1 : 1;
    });
  }, [scheduleList?.schedules]);
  const firstSchedule = sortedSchedules[0];
  const [activeTab, setActiveTab] = useState<"overview" | "schedules">("overview");
  return (
    <div className="grid h-full grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden bg-background-bright">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden py-2 pl-3 pr-1.5">
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
      <div className="flex h-8 items-end justify-between gap-2 border-b border-grid-bright pl-3 pr-1.5">
        <TabContainer className="!border-b-0">
          <TabButton
            isActive={activeTab === "overview"}
            layoutId="scheduled-task-detail-tabs"
            onClick={() => setActiveTab("overview")}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={activeTab === "schedules"}
            layoutId="scheduled-task-detail-tabs"
            onClick={() => setActiveTab("schedules")}
            shortcut={{ key: "s" }}
          >
            Schedules
          </TabButton>
        </TabContainer>
        {activeTab === "schedules" && scheduleList && scheduleList.totalPages > 1 ? (
          <div className="pb-1.5">
            <PaginationControls
              currentPage={scheduleList.currentPage}
              totalPages={scheduleList.totalPages}
              showPageNumbers={false}
            />
          </div>
        ) : null}
      </div>
      {activeTab === "overview" ? (
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
              <Property.Label>Schedule ID</Property.Label>
              <Property.Value>
                {firstSchedule ? (
                  <CopyableText value={firstSchedule.friendlyId} />
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>CRON</Property.Label>
              <Property.Value>
                {firstSchedule ? (
                  <div className="space-y-2">
                    <InlineCode variant="extra-small">{firstSchedule.cron}</InlineCode>
                    <Paragraph variant="small">{firstSchedule.cronDescription}</Paragraph>
                  </div>
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Created</Property.Label>
              <Property.Value>
                <DateTime date={task.createdAt} />
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Next run</Property.Label>
              <Property.Value>
                {firstSchedule ? (
                  <RelativeDateTime date={firstSchedule.nextRun} />
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Last run</Property.Label>
              <Property.Value>
                {firstSchedule?.lastRun ? (
                  <RelativeDateTime date={firstSchedule.lastRun} />
                ) : (
                  <span className="text-text-dimmed">Never</span>
                )}
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Status</Property.Label>
              <Property.Value>
                {firstSchedule ? (
                  <EnabledStatus enabled={firstSchedule.active} />
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </Property.Value>
            </Property.Item>
          </Property.Table>
          {scheduleList && sortedSchedules.length === 0 ? (
            <div className="mt-4">
              <NoSchedulesAttachedPanel />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          {scheduleList ? (
            sortedSchedules.length === 0 ? (
              <div className="p-3">
                <NoSchedulesAttachedPanel />
              </div>
            ) : (
              <SchedulesMiniTable
                schedules={sortedSchedules}
                variant="bright"
                onSelectSchedule={onSelectSchedule}
                showTopBorder={false}
              />
            )
          ) : (
            <TableLoading />
          )}
        </div>
      )}
    </div>
  );
}

type ScheduleRow = {
  id: string;
  friendlyId: string;
  type: "DECLARATIVE" | "IMPERATIVE";
  cron: string;
  cronDescription: string;
  externalId: string | null;
  nextRun: Date;
  lastRun: Date | undefined;
  active: boolean;
};

function SchedulesMiniTable({
  schedules,
  variant,
  onSelectSchedule,
  showTopBorder = true,
}: {
  schedules: ScheduleRow[];
  variant?: TableVariant;
  onSelectSchedule: (friendlyId: string) => void;
  showTopBorder?: boolean;
}) {
  if (schedules.length === 0) {
    return (
      <Table variant={variant} showTopBorder={showTopBorder}>
        <TableBody>
          <TableBlankRow colSpan={6}>
            <Paragraph variant="small" className="flex items-center justify-center">
              No schedules attached to this task yet.
            </Paragraph>
          </TableBlankRow>
        </TableBody>
      </Table>
    );
  }

  return (
    <Table variant={variant} showTopBorder={showTopBorder}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Schedule ID</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Cron</TableHeaderCell>
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
                <span className="font-mono text-xs">{schedule.friendlyId}</span>
              </TableCell>
              <TableCell onClick={open}>
                <span className="inline-flex items-center gap-1 text-xs text-text-dimmed">
                  <ScheduleTypeIcon
                    type={schedule.type}
                    className={schedule.type === "DECLARATIVE" ? "text-sky-500" : "text-teal-500"}
                  />
                  {scheduleTypeName(schedule.type)}
                </span>
              </TableCell>
              <TableCell onClick={open}>
                <span className="font-mono text-xs">{schedule.cron}</span>
              </TableCell>
              <TableCell onClick={open}>
                {schedule.externalId ? (
                  <span className="font-mono text-xs">{schedule.externalId}</span>
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </TableCell>
              <TableCell onClick={open}>
                <RelativeDateTime date={schedule.nextRun} />
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

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: "#28BF5C",
  RUNNING: "#3B82F6",
  FAILED: "#E11D48",
  CANCELED: "#878C99",
};

function ActivityChart({ activity }: { activity: TaskActivity }) {
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

    const ticks = showTime
      ? undefined
      : data.filter((d) => new Date(d.bucket).getUTCHours() === 0).map((d) => d.bucket);

    return { xAxisFormatter: formatter, xAxisTicks: ticks };
  }, [activity.data]);

  const tooltipLabelFormatter = useMemo(() => {
    const data = activity.data;
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

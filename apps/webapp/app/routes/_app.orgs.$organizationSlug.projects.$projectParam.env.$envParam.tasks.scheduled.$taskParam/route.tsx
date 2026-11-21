import { BookOpenIcon, PlusIcon } from "@heroicons/react/20/solid";
import { type ShouldRevalidateFunction, useFetcher, useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { typeddefer, useTypedFetcher, useTypedLoaderData } from "remix-typedjson";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { taskAgentPageContext } from "~/components/dashboard-agent/suggested-prompts";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime, RelativeDateTime } from "~/components/primitives/DateTime";
import {
  DetailMain,
  DetailPageTitle,
  DetailProperty,
  PropertyGroup,
  PropertyPair,
} from "~/components/primitives/detail/DetailPage";
import { DetailTableTab } from "~/components/primitives/detail/DetailSections";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { InlineCode } from "~/components/code/InlineCode";
import { NavBar } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Sheet, SheetContent } from "~/components/primitives/SheetV3";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { useToast } from "~/components/primitives/Toast";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleTypeCombo } from "~/components/runs/v3/ScheduleType";
import { ScheduleInspector } from "~/components/schedules/ScheduleInspector";
import { ScheduleLimitActions } from "~/components/schedules/ScheduleLimitActions";
import { SchedulesUsageBar } from "~/components/schedules/SchedulesUsageBar";
import { TaskDetailView } from "~/components/tasks/TaskDetailView";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import { loadTaskDetailPage, taskQueueAction } from "~/presenters/v3/TaskDetailPage.server";
import { onlyDetailTabChanged } from "~/utils/detailTabRevalidation";
import type { Handle } from "~/utils/handle";
import { formatNumber } from "~/utils/numberFormatter";
import { pageMeta } from "~/utils/pageTitle";
import {
  docsPath,
  v3EditSchedulePath,
  v3EnvironmentPath,
  v3NewSchedulePath,
  v3SchedulePath,
  v3SchedulesAddOnPath,
} from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";
import type { loader as scheduleDetailLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.$scheduleParam/route";
import type { loader as scheduleEditLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.edit.$scheduleParam/route";
import type { loader as scheduleNewLoader } from "../_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { UpsertScheduleForm } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.schedules.new/route";

export const handle: Handle = {
  agentPageContext: (data) => taskAgentPageContext(data),
};

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.task?.slug ?? params.taskParam ?? "Task",
  "Scheduled tasks",
]);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user, project, environment, page } = await loadTaskDetailPage({
    request,
    params,
    triggerSource: "SCHEDULED",
  });

  const url = new URL(request.url);
  const pageRaw = parseFiniteInt(url.searchParams.get("page"));
  const schedulesPage = pageRaw !== undefined && pageRaw > 0 ? pageRaw : 1;

  // Awaited: the Schedules tab, its count, the usage bar and the create button's limit check
  // all read it.
  const scheduleList = await new ScheduleListPresenter()
    .call({
      userId: user.id,
      projectId: project.id,
      environmentId: environment.id,
      tasks: [page.task.slug],
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

  return typeddefer({ ...page, scheduleList });
};

/** The Queue tab's pause, resume and override buttons post here. */
export const action = taskQueueAction;

/** Every tab's data is already loaded: switching tabs doesn't run the loader again. */
export const shouldRevalidate: ShouldRevalidateFunction = (args) =>
  onlyDetailTabChanged(args) ? false : args.defaultShouldRevalidate;

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  const { task, scheduleList, canManageBilling } = data;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

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

  const sortedSchedules = useMemo(() => {
    if (!scheduleList) return [];
    // DECLARATIVE first; createdAt-desc within each type (stable sort).
    return [...scheduleList.schedules].sort((a, b) => {
      if (a.type === b.type) return 0;
      return a.type === "DECLARATIVE" ? -1 : 1;
    });
  }, [scheduleList]);

  // Schedules add-on / quota state: drives the usage bar and the "Create schedule" button's
  // limit-exceeded intercept.
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

  const schedulesTab = (
    <div className="grid h-full grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
      <DetailTableTab
        tools={
          scheduleList && scheduleList.totalPages > 1 ? (
            <PaginationControls
              currentPage={scheduleList.currentPage}
              totalPages={scheduleList.totalPages}
              showPageNumbers={false}
            />
          ) : undefined
        }
        actions={
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
        }
      >
        {scheduleList && sortedSchedules.length === 0 ? (
          <DetailMain>
            <NoSchedulesAttachedPanel />
          </DetailMain>
        ) : (
          <SchedulesTable schedules={sortedSchedules} onSelectSchedule={openSchedule} />
        )}
      </DetailTableTab>
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
  );

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={task.slug}
          backButton={{ to: v3EnvironmentPath(organization, project, environment), text: "Tasks" }}
        />
      </NavBar>
      <PageBody scrollable={false}>
        <TaskDetailView
          data={data}
          extraTab={{
            id: "schedules",
            label: "Schedules",
            count: scheduleList ? formatNumber(scheduleList.totalCount) : undefined,
            content: schedulesTab,
          }}
          railExtra={<ScheduleRailGroup schedules={sortedSchedules} />}
        />
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

/** When the task runs next and last ran, across the schedules on this page. */
function ScheduleRailGroup({ schedules }: { schedules: ScheduleRow[] }) {
  const active = schedules.filter((schedule) => schedule.active);
  const nextRun = active
    .map((schedule) => new Date(schedule.nextRunEffectiveAt).getTime())
    .sort((a, b) => a - b)[0];
  const lastRun = schedules
    .flatMap((schedule) => (schedule.lastRun ? [new Date(schedule.lastRun).getTime()] : []))
    .sort((a, b) => b - a)[0];

  return (
    <PropertyGroup title="Schedule">
      <PropertyPair>
        <DetailProperty label="Next run">
          {nextRun !== undefined ? <RelativeDateTime date={new Date(nextRun)} /> : "–"}
        </DetailProperty>
        <DetailProperty label="Last run">
          {lastRun !== undefined ? <RelativeDateTime date={new Date(lastRun)} /> : "Never"}
        </DetailProperty>
        <DetailProperty label="Active schedules">
          {schedules.length > 0 ? `${active.length} of ${schedules.length}` : "None attached"}
        </DetailProperty>
      </PropertyPair>
    </PropertyGroup>
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

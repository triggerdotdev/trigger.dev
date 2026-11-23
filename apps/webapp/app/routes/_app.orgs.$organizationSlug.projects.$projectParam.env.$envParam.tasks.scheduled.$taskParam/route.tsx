import { BookOpenIcon, PlusIcon } from "@heroicons/react/20/solid";
import { type ShouldRevalidateFunction } from "@remix-run/react";
import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { useCallback, useMemo } from "react";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
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
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleTypeCombo } from "~/components/runs/v3/ScheduleType";
import { ScheduleFormDialog } from "~/components/schedules/ScheduleViews";
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
  v3EnvironmentPath,
  v3ScheduledTaskSchedulePath,
  v3SchedulesAddOnPath,
} from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const handle: Handle = {
  agentPageContext: (data) => taskAgentPageContext(data),
};

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.task?.slug ?? params.taskParam ?? "Task",
  "Scheduled tasks",
]);

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  // `?schedule=<id>` opened the schedule in a side sheet before it had a page of its own.
  const linkedSchedule = new URL(request.url).searchParams.get("schedule");
  if (linkedSchedule && params.organizationSlug && params.projectParam && params.envParam) {
    throw redirect(
      v3ScheduledTaskSchedulePath(
        { slug: params.organizationSlug },
        { slug: params.projectParam },
        { slug: params.envParam },
        params.taskParam ?? "",
        { friendlyId: linkedSchedule }
      )
    );
  }

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
  const { task, scheduleList, canManageBilling, canWriteTasks } = data;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const search = useSearchParams();
  const isCreatingSchedule = canWriteTasks && search.has("createSchedule");
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
            disabled={isCreatingSchedule || !canWriteTasks}
          />
        }
      >
        {scheduleList && sortedSchedules.length === 0 ? (
          <DetailMain>
            <NoSchedulesAttachedPanel />
          </DetailMain>
        ) : (
          <SchedulesTable
            schedules={sortedSchedules}
            rowLink={(schedule) =>
              v3ScheduledTaskSchedulePath(organization, project, environment, task.slug, schedule)
            }
          />
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

      <ScheduleFormDialog
        mode={isCreatingSchedule ? "new" : undefined}
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
  rowLink,
}: {
  schedules: ScheduleRow[];
  /** Each row opens this schedule's page. */
  rowLink: (schedule: ScheduleRow) => string;
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
          const link = rowLink(schedule);
          return (
            <TableRow key={schedule.id} className="group">
              <TableCell to={link} isTabbableCell>
                <span className="inline-flex flex-col gap-0.5">
                  <TruncatedText
                    text={schedule.friendlyId}
                    className="max-w-32 font-mono text-xs"
                  />
                  <ScheduleTypeCombo type={schedule.type} className="text-xs text-text-dimmed" />
                </span>
              </TableCell>
              <TableCell to={link}>
                <span className="inline-flex flex-col">
                  <span className="font-mono text-xs">{schedule.cron}</span>
                  <span className="text-xs text-text-dimmed">{schedule.timezone}</span>
                </span>
              </TableCell>
              <TableCell to={link}>
                <span className="text-xs">{schedule.window ?? "–"}</span>
              </TableCell>
              <TableCell to={link}>
                {schedule.externalId ? (
                  <span className="font-mono text-xs">{schedule.externalId}</span>
                ) : (
                  <span className="text-text-dimmed">–</span>
                )}
              </TableCell>
              <TableCell to={link}>
                <NextRun schedule={schedule} />
              </TableCell>
              <TableCell to={link}>
                {schedule.lastRun ? (
                  <RelativeDateTime date={schedule.lastRun} />
                ) : (
                  <span className="text-text-dimmed">Never</span>
                )}
              </TableCell>
              <TableCell to={link}>
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

import { ClockIcon, LockOpenIcon, PlusIcon, RectangleGroupIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { Outlet, useLocation, useParams } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Feedback } from "~/components/Feedback";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabels } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  ScheduleTypeCombo,
  ScheduleTypeIcon,
  scheduleTypeName,
} from "~/components/runs/v3/ScheduleType";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleFilters, ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { useOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import {
  type ScheduleListItem,
  ScheduleListPresenter,
} from "~/presenters/v3/ScheduleListPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  ProjectParamSchema,
  docsPath,
  v3BillingPath,
  v3NewSchedulePath,
  v3SchedulePath,
} from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const filters = ScheduleListFilters.parse(s);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const presenter = new ScheduleListPresenter();
  const list = await presenter.call({
    userId,
    projectId: project.id,
    ...filters,
  });

  return typedjson(list);
};

export default function Page() {
  const {
    schedules,
    possibleTasks,
    possibleEnvironments,
    hasFilters,
    filters,
    limits,
    currentPage,
    totalPages,
  } = useTypedLoaderData<typeof loader>();
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();
  const pathName = usePathName();

  const plan = useCurrentPlan();
  const requiresUpgrade =
    plan?.v3Subscription?.plan &&
    limits.used >= plan.v3Subscription.plan.limits.schedules.number &&
    !plan.v3Subscription.plan.limits.schedules.canExceed;
  const canUpgrade =
    plan?.v3Subscription?.plan && !plan.v3Subscription.plan.limits.schedules.canExceed;

  const { scheduleParam } = useParams();
  const isShowingNewPane = pathName.endsWith("/new");
  const isShowingSchedule = !!scheduleParam;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Schedules" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {schedules.map((schedule) => (
                <Property.Item key={schedule.id}>
                  <Property.Label>{schedule.friendlyId}</Property.Label>
                  <Property.Value>{schedule.id}</Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>

          {limits.used >= limits.limit ? (
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  LeadingIcon={PlusIcon}
                  variant="primary/small"
                  shortcut={{ key: "n" }}
                  disabled={possibleTasks.length === 0 || isShowingNewPane}
                >
                  New schedule
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>You've exceeded your limit</DialogHeader>
                <DialogDescription>
                  You've used {limits.used}/{limits.limit} of your schedules.
                </DialogDescription>
                <DialogFooter>
                  {canUpgrade ? (
                    <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
                      Upgrade
                    </LinkButton>
                  ) : (
                    <Feedback
                      button={<Button variant="primary/small">Request more</Button>}
                      defaultValue="help"
                    />
                  )}
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : (
            <LinkButton
              LeadingIcon={PlusIcon}
              to={`${v3NewSchedulePath(organization, project)}${location.search}`}
              variant="primary/small"
              shortcut={{ key: "n" }}
              disabled={possibleTasks.length === 0 || isShowingNewPane}
            >
              New schedule
            </LinkButton>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup direction="horizontal" className="h-full max-h-full">
          <ResizablePanel order={1} minSize={20} defaultSize={60}>
            <div className="max-h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
              {possibleTasks.length === 0 ? (
                <CreateScheduledTaskInstructions />
              ) : schedules.length === 0 && !hasFilters ? (
                <AttachYourFirstScheduleInstructions />
              ) : (
                <div className="p-3">
                  <div className="mb-2 flex items-center justify-between gap-x-2">
                    <ScheduleFilters
                      possibleEnvironments={possibleEnvironments}
                      possibleTasks={possibleTasks}
                    />
                    <div className="flex items-center justify-end gap-x-2">
                      <PaginationControls
                        currentPage={currentPage}
                        totalPages={totalPages}
                        showPageNumbers={false}
                      />
                    </div>
                  </div>

                  <SchedulesTable schedules={schedules} hasFilters={hasFilters} />
                  <div className="mt-3 flex w-full items-start justify-between">
                    {requiresUpgrade ? (
                      <InfoPanel
                        variant="upgrade"
                        icon={LockOpenIcon}
                        iconClassName="text-indigo-500"
                        title="Unlock more schedules"
                        to={v3BillingPath(organization)}
                        buttonLabel="Upgrade"
                      >
                        <Paragraph variant="small">
                          You've used all {limits.limit} of your available schedules. Upgrade your
                          plan to enable more.
                        </Paragraph>
                      </InfoPanel>
                    ) : (
                      <div className="flex h-fit flex-col items-start gap-4 rounded-md border border-grid-bright bg-background-bright p-4">
                        <div className="flex items-center justify-between gap-6">
                          <Header3>
                            You've used {limits.used}/{limits.limit} of your schedules.
                          </Header3>

                          {canUpgrade ? (
                            <LinkButton to={v3BillingPath(organization)} variant="secondary/small">
                              Upgrade
                            </LinkButton>
                          ) : (
                            <Feedback
                              button={<Button variant="secondary/small">Request more</Button>}
                              defaultValue="help"
                            />
                          )}
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full border border-grid-bright">
                          <div
                            className="h-full bg-grid-bright"
                            style={{ width: `${(limits.used / limits.limit) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}
                    <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                  </div>
                </div>
              )}
            </div>
          </ResizablePanel>
          {(isShowingNewPane || isShowingSchedule) && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel order={2} minSize={20} defaultSize={40}>
                <Outlet />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

function CreateScheduledTaskInstructions() {
  return (
    <MainCenteredContainer className="max-w-md">
      <InfoPanel
        title="Create your first scheduled task"
        icon={ClockIcon}
        iconClassName="text-sun-500"
        panelClassName="max-w-full"
        to={docsPath("v3/tasks-scheduled")}
        buttonLabel="Scheduled task docs"
      >
        <Paragraph variant="small">
          You have no scheduled tasks in your project. Before you can schedule a task you need to
          create a <InlineCode>schedules.task</InlineCode>.
        </Paragraph>
      </InfoPanel>
    </MainCenteredContainer>
  );
}

function AttachYourFirstScheduleInstructions() {
  const organization = useOrganization();
  const project = useProject();
  const location = useLocation();

  return (
    <MainCenteredContainer className="max-w-md">
      <InfoPanel
        title="Attach your first schedule"
        icon={ClockIcon}
        iconClassName="text-sun-500"
        panelClassName="max-w-full"
      >
        <Paragraph spacing variant="small">
          Scheduled tasks will only run automatically if you connect a schedule to them, you can do
          this in the dashboard or using the SDK.
        </Paragraph>
        <div className="flex gap-2">
          <LinkButton
            to={`${v3NewSchedulePath(organization, project)}${location.search}`}
            variant="primary/small"
            LeadingIcon={RectangleGroupIcon}
            className="inline-flex"
          >
            Use the dashboard
          </LinkButton>
          <LinkButton
            to={docsPath("v3/tasks-scheduled")}
            variant="primary/small"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            Use the SDK
          </LinkButton>
        </div>
      </InfoPanel>
    </MainCenteredContainer>
  );
}

function SchedulesTable({
  schedules,
  hasFilters,
}: {
  schedules: ScheduleListItem[];
  hasFilters: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const location = useLocation();
  const { scheduleParam } = useParams();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Task ID</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="flex max-w-xs flex-col gap-4 p-1">
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5 text-sm">
                    <div className={"flex items-center space-x-1"}>
                      <ScheduleTypeIcon type={"DECLARATIVE"} className="text-sky-500" />
                      <span className="font-medium">{scheduleTypeName("DECLARATIVE")}</span>
                    </div>
                  </div>
                  <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                    Declarative schedules are defined in a{" "}
                    <InlineCode variant="extra-small">schedules.task</InlineCode> with the{" "}
                    <InlineCode variant="extra-small">cron</InlineCode>
                    property. They sync when you update your{" "}
                    <InlineCode variant="extra-small">schedules.task</InlineCode> definition and run
                    the CLI dev or deploy commands.
                  </Paragraph>
                </div>
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5 text-sm">
                    <div className={"flex items-center space-x-1"}>
                      <ScheduleTypeIcon type={"IMPERATIVE"} className="text-teal-500" />
                      <span className="font-medium">{scheduleTypeName("IMPERATIVE")}</span>
                    </div>
                  </div>
                  <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                    Imperative schedules are defined here in the dashboard or by using the SDK
                    functions to create or delete them. They can be created, updated, disabled, and
                    deleted from the dashboard or using the SDK.
                  </Paragraph>
                </div>
                <div>
                  <LinkButton
                    variant="tertiary/medium"
                    to="https://trigger.dev/docs/v3/tasks-scheduled"
                  >
                    View the docs
                  </LinkButton>
                </div>
              </div>
            }
          >
            Type
          </TableHeaderCell>
          <TableHeaderCell>External ID</TableHeaderCell>
          <TableHeaderCell>CRON</TableHeaderCell>
          <TableHeaderCell hiddenLabel>CRON description</TableHeaderCell>
          <TableHeaderCell>Timezone</TableHeaderCell>
          <TableHeaderCell>Next run</TableHeaderCell>
          <TableHeaderCell>Last run</TableHeaderCell>
          <TableHeaderCell>Deduplication key</TableHeaderCell>
          <TableHeaderCell>Environments</TableHeaderCell>
          <TableHeaderCell>Enabled</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.length === 0 ? (
          <TableBlankRow colSpan={10}>There are no matches for your filters</TableBlankRow>
        ) : (
          schedules.map((schedule) => {
            const path = `${v3SchedulePath(organization, project, schedule)}${location.search}`;
            const isSelected = scheduleParam === schedule.friendlyId;
            const cellClass = schedule.active ? "" : "opacity-50";
            return (
              <TableRow key={schedule.id} className={isSelected ? "bg-grid-dimmed" : undefined}>
                <TableCell to={path} className={cellClass}>
                  {schedule.friendlyId}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  {schedule.taskIdentifier}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  <ScheduleTypeCombo type={schedule.type} />
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  {schedule.type === "IMPERATIVE"
                    ? schedule.externalId
                      ? schedule.externalId
                      : "–"
                    : "N/A"}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  {schedule.cron}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  {schedule.cronDescription}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  {schedule.timezone}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  <DateTime date={schedule.nextRun} timeZone={schedule.timezone} />
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  {schedule.lastRun ? (
                    <DateTime date={schedule.lastRun} timeZone={schedule.timezone} />
                  ) : (
                    "–"
                  )}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  {schedule.type === "IMPERATIVE"
                    ? schedule.userProvidedDeduplicationKey
                      ? schedule.deduplicationKey
                      : "–"
                    : "N/A"}
                </TableCell>
                <TableCell to={path} className={cellClass}>
                  <EnvironmentLabels environments={schedule.environments} size="small" />
                </TableCell>
                <TableCell to={path}>
                  {schedule.type === "IMPERATIVE" ? (
                    <EnabledStatus enabled={schedule.active} />
                  ) : (
                    "N/A"
                  )}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

import { ArrowUpCircleIcon, PlusIcon } from "@heroicons/react/20/solid";
import { BookOpenIcon } from "@heroicons/react/24/solid";
import { type MetaFunction, Outlet, useLocation, useParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { SchedulesNoneAttached, SchedulesNoPossibleTaskPanel } from "~/components/BlankStatePanels";
import { Feedback } from "~/components/Feedback";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
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
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { ScheduleFilters, ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import {
  ScheduleTypeCombo,
  ScheduleTypeIcon,
  scheduleTypeName,
} from "~/components/runs/v3/ScheduleType";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type ScheduleListItem,
  ScheduleListPresenter,
} from "~/presenters/v3/ScheduleListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  EnvironmentParamSchema,
  v3BillingPath,
  v3NewSchedulePath,
  v3SchedulePath,
} from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Schedules | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return redirectWithErrorMessage("/", request, "Project not found");
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return redirectWithErrorMessage("/", request, "Environment not found");
  }

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const filters = ScheduleListFilters.parse(s);
  filters.environments = [environment.id];

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
    limits,
    currentPage,
    totalPages,
  } = useTypedLoaderData<typeof loader>();
  const location = useLocation();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
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

          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/tasks/scheduled")}
          >
            Schedules docs
          </LinkButton>

          {limits.used >= limits.limit ? (
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  LeadingIcon={PlusIcon}
                  leadingIconClassName="text-background-dimmed"
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
              to={`${v3NewSchedulePath(organization, project, environment)}${location.search}`}
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
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="schedules-main" min={"100px"}>
            <div className="grid max-h-full min-h-full grid-rows-[auto_1fr_auto]">
              {possibleTasks.length === 0 ? (
                <MainCenteredContainer className="max-w-md">
                  <SchedulesNoPossibleTaskPanel />
                </MainCenteredContainer>
              ) : schedules.length === 0 && !hasFilters ? (
                <MainCenteredContainer className="max-w-md">
                  <SchedulesNoneAttached />
                </MainCenteredContainer>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-x-2 p-2">
                    <ScheduleFilters possibleTasks={possibleTasks} />
                    <div className="flex items-center justify-end gap-x-2">
                      <PaginationControls
                        currentPage={currentPage}
                        totalPages={totalPages}
                        showPageNumbers={false}
                      />
                    </div>
                  </div>

                  <div
                    className={cn(
                      "grid h-fit max-h-full min-h-full overflow-x-auto",
                      totalPages > 1 ? "grid-rows-[1fr_auto]" : "grid-rows-[1fr]"
                    )}
                  >
                    <SchedulesTable schedules={schedules} hasFilters={hasFilters} />
                    <div
                      className={cn(
                        "flex min-h-full",
                        totalPages > 1 && "justify-end border-t border-grid-dimmed px-2 py-3"
                      )}
                    >
                      <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                    </div>
                  </div>

                  <div className="flex w-full items-start justify-between">
                    <div className="flex h-fit w-full items-center gap-4 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
                      <SimpleTooltip
                        button={
                          <div className="size-6">
                            <svg className="h-full w-full -rotate-90 overflow-visible">
                              <circle
                                className="fill-none stroke-grid-bright"
                                strokeWidth="4"
                                r="10"
                                cx="12"
                                cy="12"
                              />
                              <circle
                                className={`fill-none ${
                                  requiresUpgrade ? "stroke-error" : "stroke-success"
                                }`}
                                strokeWidth="4"
                                r="10"
                                cx="12"
                                cy="12"
                                strokeDasharray={`${(limits.used / limits.limit) * 62.8} 62.8`}
                                strokeDashoffset="0"
                                strokeLinecap="round"
                              />
                            </svg>
                          </div>
                        }
                        content={`${Math.round((limits.used / limits.limit) * 100)}%`}
                      />
                      <div className="flex w-full items-center justify-between gap-6">
                        {requiresUpgrade ? (
                          <Header3 className="text-error">
                            You've used all {limits.limit} of your available schedules. Upgrade your
                            plan to enable more.
                          </Header3>
                        ) : (
                          <Header3>
                            You've used {limits.used}/{limits.limit} of your schedules.
                          </Header3>
                        )}

                        {canUpgrade ? (
                          <LinkButton
                            to={v3BillingPath(organization)}
                            variant="secondary/small"
                            LeadingIcon={ArrowUpCircleIcon}
                          >
                            Upgrade
                          </LinkButton>
                        ) : (
                          <Feedback
                            button={<Button variant="secondary/small">Request more</Button>}
                            defaultValue="help"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </ResizablePanel>
          {(isShowingNewPane || isShowingSchedule) && (
            <>
              <ResizableHandle id="schedules-handle" />
              <ResizablePanel id="schedules-inspector" min="100px" default="500px">
                <Outlet />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
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
  const environment = useEnvironment();
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
                <LinkButton
                  variant="docs/small"
                  to={docsPath("v3/tasks-scheduled")}
                  LeadingIcon={BookOpenIcon}
                  className="mb-1"
                >
                  View the docs
                </LinkButton>
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
            const path = `${v3SchedulePath(organization, project, environment, schedule)}${
              location.search
            }`;
            const isSelected = scheduleParam === schedule.friendlyId;
            const cellClass = schedule.active ? "" : "opacity-50";
            return (
              <TableRow key={schedule.id} className={isSelected ? "bg-grid-dimmed" : undefined}>
                <TableCell to={path} isTabbableCell className={cellClass}>
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
                  <div className="flex items-center gap-3">
                    {schedule.environments.map((env) => (
                      <EnvironmentCombo key={env.id} environment={env} className="text-xs" />
                    ))}
                  </div>
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

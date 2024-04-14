import { BeakerIcon, BookOpenIcon } from "@heroicons/react/24/solid";
import { Outlet, useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { BlankstateInstructions } from "~/components/BlankstateInstructions";
import { StepContentContainer } from "~/components/StepContentContainer";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import { RunsFilters, TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/v3/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  ProjectParamSchema,
  docsPath,
  newProjectPath,
  v3NewSchedulePath,
  v3ProjectPath,
  v3TestPath,
} from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";
import { TextLink } from "~/components/primitives/TextLink";
import { PlusIcon } from "@heroicons/react/20/solid";
import { ScheduleFilters, ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { PaginationControls } from "~/components/primitives/Pagination";
import {
  ScheduleListItem,
  ScheduleListPresenter,
} from "~/presenters/v3/ScheduleListPresenter.server";
import { InlineCode } from "~/components/code/InlineCode";
import { Callout } from "~/components/primitives/Callout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { usePathName } from "~/hooks/usePathName";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { DateTime } from "~/components/primitives/DateTime";
import { envDetector } from "@opentelemetry/resources";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const url = new URL(request.url);
  const s = Object.fromEntries(url.searchParams.entries());
  const filters = ScheduleListFilters.parse(s);

  const presenter = new ScheduleListPresenter();
  const list = await presenter.call({
    userId,
    projectSlug: projectParam,
    ...filters,
  });

  return typedjson(list);
};

export default function Page() {
  const { schedules, possibleTasks, hasFilters, filters, currentPage, totalPages } =
    useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();
  const pathName = usePathName();

  const isShowingNewPane = pathName.endsWith("/new");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Schedules" />
        <PageAccessories>
          <LinkButton
            LeadingIcon={PlusIcon}
            to={v3NewSchedulePath(organization, project)}
            variant="primary/small"
            shortcut={{ key: "n" }}
            disabled={possibleTasks.length === 0 || isShowingNewPane}
          >
            New schedule
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {possibleTasks.length === 0 ? (
          <CreateScheduledTaskInstructions />
        ) : (
          <>
            <ResizablePanelGroup direction="horizontal" className="h-full max-h-full">
              <ResizablePanel order={1} minSize={20} defaultSize={60}>
                <div className="p-3">
                  <div className="mb-2 flex items-center justify-between gap-x-2">
                    <ScheduleFilters
                      possibleEnvironments={project.environments}
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
                  <div className="mt-2 justify-end">
                    <PaginationControls currentPage={currentPage} totalPages={totalPages} />
                  </div>
                </div>
              </ResizablePanel>
              {isShowingNewPane && (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel order={2} minSize={20} defaultSize={40}>
                    <Outlet />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </>
        )}
      </PageBody>
    </PageContainer>
  );
}

function CreateScheduledTaskInstructions() {
  return (
    <MainCenteredContainer className="max-w-prose">
      <BlankstateInstructions title="Create your first task">
        <Paragraph spacing>
          You have no scheduled tasks in your project. Before you can schedule a task you need a{" "}
          <InlineCode>scheduled.task</InlineCode> to attach it to.
        </Paragraph>
        <LinkButton
          to={docsPath("v3/tasks-scheduled")}
          variant="primary/medium"
          LeadingIcon={BookOpenIcon}
          className="inline-flex"
        >
          Create scheduled task docs
        </LinkButton>
      </BlankstateInstructions>
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
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Task ID</TableHeaderCell>
          <TableHeaderCell>CRON</TableHeaderCell>
          <TableHeaderCell hiddenLabel>CRON description</TableHeaderCell>
          <TableHeaderCell>External ID</TableHeaderCell>
          <TableHeaderCell>Deduplication key</TableHeaderCell>
          <TableHeaderCell>Next run (UTC)</TableHeaderCell>
          <TableHeaderCell>Last run (UTC)</TableHeaderCell>
          <TableHeaderCell>Environments</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {schedules.map((schedule) => (
          <TableRow key={schedule.id}>
            <TableCell>{schedule.friendlyId}</TableCell>
            <TableCell>{schedule.taskIdentifier}</TableCell>
            <TableCell>{schedule.cron}</TableCell>
            <TableCell>{schedule.cronDescription}</TableCell>
            <TableCell>{schedule.externalId}</TableCell>
            <TableCell>
              {schedule.userProvidedDeduplicationKey ? schedule.deduplicationKey : null}
            </TableCell>
            <TableCell>
              <DateTime date={schedule.nextRun} />
            </TableCell>
            <TableCell>Implement</TableCell>
            <TableCell>
              <div className="flex gap-1">
                {schedule.environments.map((environment) => (
                  <EnvironmentLabel
                    key={environment.id}
                    environment={environment}
                    userName={environment.userName}
                  />
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

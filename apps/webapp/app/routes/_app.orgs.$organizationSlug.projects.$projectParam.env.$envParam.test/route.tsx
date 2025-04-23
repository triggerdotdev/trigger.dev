import { BookOpenIcon, MagnifyingGlassIcon } from "@heroicons/react/20/solid";
import { type MetaFunction, Outlet, useNavigation, useParams } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TestHasNoTasks } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
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
import { TaskTriggerSourceIcon } from "~/components/runs/v3/TaskTriggerSource";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFuzzyFilter } from "~/hooks/useFuzzyFilter";
import { useLinkStatus } from "~/hooks/useLinkStatus";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { type TaskListItem, TestPresenter } from "~/presenters/v3/TestPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { docsPath, EnvironmentParamSchema, v3TestTaskPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Test | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

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

  const presenter = new TestPresenter();
  const result = await presenter.call({
    userId,
    projectId: project.id,
    environmentId: environment.id,
    environmentType: environment.type,
  });

  return typedjson(result);
};

export default function Page() {
  const { tasks } = useTypedLoaderData<typeof loader>();
  const { taskParam } = useParams();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Test" />
        <PageAccessories>
          <LinkButton variant={"docs/small"} LeadingIcon={BookOpenIcon} to={docsPath("/run-tests")}>
            Test docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {tasks.length === 0 ? (
          <MainCenteredContainer className="max-w-md">
            <TestHasNoTasks />
          </MainCenteredContainer>
        ) : (
          <div className={cn("grid h-full max-h-full grid-cols-1")}>
            <ResizablePanelGroup orientation="horizontal" className="h-full max-h-full">
              <ResizablePanel id="test-selector" min="200px" default="20%">
                <TaskSelector tasks={tasks} activeTaskIdentifier={taskParam} />
              </ResizablePanel>
              <ResizableHandle id="test-handle" />
              <ResizablePanel id="test-main" min="225px">
                <Outlet key={taskParam} />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        )}
      </PageBody>
    </PageContainer>
  );
}

function TaskSelector({
  tasks,
  activeTaskIdentifier,
}: {
  tasks: TaskListItem[];
  activeTaskIdentifier?: string;
}) {
  const { filterText, setFilterText, filteredItems } = useFuzzyFilter<TaskListItem>({
    items: tasks,
    keys: ["taskIdentifier", "friendlyId", "id", "filePath", "triggerSource"],
  });
  const hasTaskInEnvironment = activeTaskIdentifier
    ? tasks.some((t) => t.taskIdentifier === activeTaskIdentifier)
    : undefined;

  return (
    <div
      className={cn(
        "grid h-full max-h-full overflow-hidden",
        hasTaskInEnvironment === false ? "grid-rows-[auto_auto_1fr]" : "grid-rows-[auto_1fr]"
      )}
    >
      <div className="p-2">
        <Input
          placeholder="Search tasks"
          variant="medium"
          icon={MagnifyingGlassIcon}
          fullWidth={true}
          value={filterText}
          autoFocus
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>
      {hasTaskInEnvironment === false && (
        <div className="px-2 pb-2">
          <Callout variant="warning" className="text-sm text-yellow-300">
            There is no "{activeTaskIdentifier}" task in the selected environment.
          </Callout>
        </div>
      )}
      <Table>
        <TableHeader className="hidden">
          <TableRow>
            <TableHeaderCell className="w-[1%]" />
            <TableHeaderCell className="pl-0">Task</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredItems.length > 0 ? (
            filteredItems.map((t) => <TaskRow key={t.friendlyId} task={t} />)
          ) : (
            <TableBlankRow colSpan={2}>
              <Paragraph spacing variant="small">
                No tasks match "{filterText}"
              </Paragraph>
            </TableBlankRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function TaskRow({ task }: { task: TaskListItem }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const path = v3TestTaskPath(organization, project, environment, task);
  const { isActive, isPending } = useLinkStatus(path);

  return (
    <TableRow
      key={task.taskIdentifier}
      className={cn((isActive || isPending) && "bg-indigo-500/10")}
    >
      <TableCell
        to={path}
        actionClassName="pl-2.5 pr-2 py-1"
        className={cn("w-[1%]", (isActive || isPending) && "group-hover/table-row:bg-indigo-500/5")}
      >
        <RadioButtonCircle checked={isActive || isPending} />
      </TableCell>
      <TableCell
        to={path}
        isTabbableCell
        actionClassName="pl-0 pr-2"
        className={cn((isActive || isPending) && "group-hover/table-row:bg-indigo-500/5")}
      >
        <div className="flex items-center gap-1.5">
          <TaskTriggerSourceIcon source={task.triggerSource} />
          <Paragraph variant="extra-small" className="text-text-dimmed">
            {task.taskIdentifier}
          </Paragraph>
        </div>
      </TableCell>
    </TableRow>
  );
}

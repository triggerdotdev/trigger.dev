import { BookOpenIcon } from "@heroicons/react/20/solid";
import {
  Link,
  MetaFunction,
  Outlet,
  useLocation,
  useNavigation,
  useParams,
} from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  environmentBorderClassName,
  environmentTextClassName,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
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
} from "~/components/primitives/Table";
import { TaskFunctionName } from "~/components/runs/v3/TaskPath";
import { TaskTriggerSourceIcon } from "~/components/runs/v3/TaskTriggerSource";
import { useFilterTasks } from "~/hooks/useFilterTasks";
import { useLinkStatus } from "~/hooks/useLinkStatus";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  SelectedEnvironment,
  TaskListItem,
  TestPresenter,
} from "~/presenters/v3/TestPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { docsPath, ProjectParamSchema, v3TestPath, v3TestTaskPath } from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Test | Trigger.dev`,
    },
  ];
};

export const TestSearchParams = z.object({
  environment: z.string().optional(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const presenter = new TestPresenter();
  const result = await presenter.call({
    userId,
    projectSlug: projectParam,
    url: request.url,
  });

  return typedjson(result);
};

export default function Page() {
  const { hasSelectedEnvironment, environments, ...rest } = useTypedLoaderData<typeof loader>();
  const { taskParam } = useParams();
  const organization = useOrganization();
  const project = useProject();

  //get optimistic location for the segment control
  const optimisticLocation = useOptimisticLocation();
  const environment = new URLSearchParams(optimisticLocation.search).get("environment") ?? "dev";

  const navigation = useNavigation();

  const location = useLocation();
  const currentEnvironment = new URLSearchParams(location.search).get("environment");
  const pendingEnvironment = new URLSearchParams(navigation.location?.search).get("environment");

  const isLoadingTasks =
    navigation.state === "loading" &&
    navigation.location.pathname === location.pathname &&
    currentEnvironment !== pendingEnvironment;

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
        <div className={cn("grid h-full max-h-full grid-cols-1")}>
          <ResizablePanelGroup orientation="horizontal" className="h-full max-h-full">
            <ResizablePanel id="test-selector" min="225px" default="30%">
              <div className="grid h-full max-h-full grid-rows-[5.625rem_1fr] overflow-hidden">
                <div className="mx-3 flex flex-col gap-1 border-b border-grid-dimmed">
                  <div className="flex h-10 items-center">
                    <Header2>Select an environment</Header2>
                  </div>
                  <div className="flex items-center justify-stretch gap-1">
                    {environments.map((env) => {
                      const isSelected = env.slug === environment;
                      return (
                        <Link
                          className={cn(
                            "flex h-8 flex-1 items-center justify-center rounded-sm border text-xs uppercase tracking-wider",
                            isSelected
                              ? cn(environmentBorderClassName(env), environmentTextClassName(env))
                              : "border-grid-bright text-text-dimmed transition hover:border-charcoal-600 hover:text-text-bright"
                          )}
                          key={env.id}
                          to={
                            taskParam
                              ? v3TestTaskPath(
                                  organization,
                                  project,
                                  { taskIdentifier: taskParam },
                                  env.slug
                                )
                              : v3TestPath(organization, project, env.slug)
                          }
                        >
                          <span>{environmentTitle(env)}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
                {isLoadingTasks ? (
                  <div className="flex h-full w-full items-center justify-center">
                    <Spinner />
                  </div>
                ) : hasSelectedEnvironment ? (
                  <div className="grid grid-rows-[auto_1fr] overflow-hidden">
                    <div className="flex items-end px-3 pt-2">
                      <Header2>Select a task</Header2>
                    </div>
                    {!rest.tasks?.length ? (
                      <NoTaskInstructions environment={rest.selectedEnvironment} />
                    ) : (
                      <TaskSelector
                        tasks={rest.tasks}
                        environmentSlug={rest.selectedEnvironment.slug}
                        activeTaskIdentifier={taskParam}
                      />
                    )}
                  </div>
                ) : (
                  <></>
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle id="test-handle" />
            <ResizablePanel id="test-main" min="225px">
              <Outlet key={taskParam} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function TaskSelector({
  tasks,
  environmentSlug,
  activeTaskIdentifier,
}: {
  tasks: TaskListItem[];
  environmentSlug: string;
  activeTaskIdentifier?: string;
}) {
  const { filterText, setFilterText, filteredItems } = useFilterTasks<TaskListItem>({ tasks });
  const hasTaskInEnvironment = activeTaskIdentifier
    ? tasks.some((t) => t.taskIdentifier === activeTaskIdentifier)
    : undefined;

  return (
    <div
      className={cn(
        "grid max-h-full  overflow-hidden",
        hasTaskInEnvironment === false ? "grid-rows-[auto_auto_1fr]" : "grid-rows-[auto_1fr]"
      )}
    >
      <div className="p-2">
        <Input
          placeholder="Search tasks"
          variant="medium"
          icon="search"
          fullWidth={true}
          value={filterText}
          autoFocus
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>
      {hasTaskInEnvironment === false && (
        <div className="px-2 pb-2">
          <Callout variant="warning">
            There is no task {activeTaskIdentifier} in the selected environment.
          </Callout>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHeaderCell className="pl-3" colSpan={2}>
              Task
            </TableHeaderCell>
            <TableHeaderCell className="px-2">File path</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredItems.length > 0 ? (
            filteredItems.map((t) => (
              <TaskRow key={t.friendlyId} task={t} environmentSlug={environmentSlug} />
            ))
          ) : (
            <TableBlankRow colSpan={3}>
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

function NoTaskInstructions({ environment }: { environment?: SelectedEnvironment }) {
  return (
    <div className="px-3 py-3">
      <Callout variant="info">
        You have no tasks {environment ? `in ${environmentTitle(environment)}` : ""}.
      </Callout>
    </div>
  );
}

function TaskRow({ task, environmentSlug }: { task: TaskListItem; environmentSlug: string }) {
  const organization = useOrganization();
  const project = useProject();

  const path = v3TestTaskPath(organization, project, task, environmentSlug);
  const { isActive, isPending } = useLinkStatus(path);

  return (
    <TableRow
      key={task.taskIdentifier}
      className={cn((isActive || isPending) && "bg-indigo-500/10")}
    >
      <TableCell
        to={path}
        actionClassName="pl-2.5 pr-2 py-1"
        className={cn((isActive || isPending) && "group-hover/table-row:bg-indigo-500/5")}
      >
        <RadioButtonCircle checked={isActive || isPending} />
      </TableCell>
      <TableCell
        to={path}
        isTabbableCell
        actionClassName="pl-1 pr-2 py-1.5"
        className={cn((isActive || isPending) && "group-hover/table-row:bg-indigo-500/5")}
      >
        <div className="flex flex-col gap-0.5">
          <TaskFunctionName
            variant="extra-small"
            functionName={task.exportName}
            className="inline-flex w-fit"
          />
          <div className="flex items-start gap-1">
            <TaskTriggerSourceIcon source={task.triggerSource} className="size-3.5" />
            <Paragraph variant="extra-small" className="text-text-dimmed">
              {task.taskIdentifier}
            </Paragraph>
          </div>
        </div>
      </TableCell>

      <TableCell
        to={path}
        actionClassName="px-2 py-1"
        className={cn((isActive || isPending) && "group-hover/table-row:bg-indigo-500/5")}
      >
        {task.filePath}
      </TableCell>
    </TableRow>
  );
}

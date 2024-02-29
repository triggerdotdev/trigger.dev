import { NavLink, Outlet, useNavigation, useParams } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { TaskPath } from "~/components/runs/v3/TaskPath";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { TaskListItem, TestPresenter } from "~/presenters/v3/TestPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3TestTaskPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const presenter = new TestPresenter();
  const { tasks } = await presenter.call({
    userId,
    projectSlug: projectParam,
  });

  return typedjson({
    tasks,
  });
};

export default function Page() {
  const { tasks } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const project = useProject();
  const user = useUser();
  const { taskParam } = useParams();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Test" />
      </NavBar>
      <PageBody scrollable={false}>
        <div className={cn("grid h-full max-h-full grid-cols-1")}>
          <ResizablePanelGroup direction="horizontal" className="h-full max-h-full">
            <ResizablePanel order={1} minSize={20} defaultSize={30}>
              <div className="flex flex-col px-3">
                <Header2>Select a task</Header2>
                <TaskSelector tasks={tasks} />
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel order={2} minSize={30} defaultSize={70}>
              <Outlet key={taskParam} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function TaskSelector({ tasks }: { tasks: TaskListItem[] }) {
  const organization = useOrganization();
  const project = useProject();

  return (
    <div className="flex flex-col divide-y divide-charcoal-800">
      {tasks.map((t) => (
        <NavLink key={t.id} to={v3TestTaskPath(organization, project, t)}>
          {({ isActive, isPending }) => (
            <div
              className={cn(
                "relative flex items-center gap-2 overflow-hidden truncate rounded-sm px-2 py-2",
                (isActive || isPending) && "z-20 outline outline-1 outline-indigo-500"
              )}
            >
              <RadioButtonCircle checked={isActive || isPending} />
              <div className="flex w-full items-center justify-between gap-2">
                <TaskPath
                  filePath={t.filePath}
                  functionName={`${t.exportName}()`}
                  className="text-xs"
                />
                <EnvironmentLabel environment={t.environment} />
              </div>
            </div>
          )}
        </NavLink>
      ))}
    </div>
  );
}

import { NavLink, Outlet, useParams } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { BlankstateInstructions } from "~/components/BlankstateInstructions";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { TextLink } from "~/components/primitives/TextLink";
import { TaskPath } from "~/components/runs/v3/TaskPath";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { TaskListItem, TestPresenter } from "~/presenters/v3/TestPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3ProjectPath, v3TestTaskPath } from "~/utils/pathBuilder";

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
              <div className="flex h-full max-h-full flex-col overflow-hidden px-3">
                {tasks.length === 0 ? (
                  <NoTaskInstructions />
                ) : (
                  <>
                    <div className="flex h-10 items-center border-b border-grid-dimmed">
                      <Header2>Select a task</Header2>
                    </div>
                    <TaskSelector tasks={tasks} />
                  </>
                )}
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
    <div className="flex flex-col divide-y divide-charcoal-800 overflow-y-auto">
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

function NoTaskInstructions() {
  const organization = useOrganization();
  const project = useProject();
  return (
    <BlankstateInstructions title="Create your first task">
      <Paragraph spacing variant="small">
        Before testing, you must first create a task. Follow the instructions on the{" "}
        <TextLink to={v3ProjectPath(organization, project)}>Tasks</TextLink> page to create a task
        then return here to run a test.
      </Paragraph>
      <LinkButton
        to={v3ProjectPath(organization, project)}
        variant="primary/small"
        LeadingIcon={TaskIcon}
        className="inline-flex"
      >
        Create your first task
      </LinkButton>
    </BlankstateInstructions>
  );
}

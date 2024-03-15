import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Feedback } from "~/components/Feedback";
import { InitCommandV3, TriggerDevStepV3 } from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Header1 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { StepNumber } from "~/components/primitives/StepNumber";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TaskFunctionName, TaskPath } from "~/components/runs/v3/TaskPath";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { TaskListPresenter } from "~/presenters/v3/TaskListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3RunsPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new TaskListPresenter();
    const tasks = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
    });

    return typedjson({
      tasks,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const user = useUser();
  const { tasks } = useTypedLoaderData<typeof loader>();
  const hasTasks = tasks.length > 0;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
      </NavBar>
      <PageBody>
        <div className={cn("grid h-full grid-cols-1 gap-4")}>
          <div className="h-full">
            {hasTasks ? (
              <div className="flex flex-col gap-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Task ID</TableHeaderCell>
                      <TableHeaderCell>Task</TableHeaderCell>
                      <TableHeaderCell>Path</TableHeaderCell>
                      <TableHeaderCell>Environment</TableHeaderCell>
                      <TableHeaderCell>Last run</TableHeaderCell>
                      <TableHeaderCell>
                        <div className="sr-only">Last run status</div>
                      </TableHeaderCell>
                      <TableHeaderCell>Created at</TableHeaderCell>
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.length > 0 ? (
                      tasks.map((task) => {
                        const usernameForEnv =
                          user.id !== task.environment.userId
                            ? task.environment.userName
                            : undefined;
                        const path = v3RunsPath(organization, project, {
                          tasks: [task.slug],
                          environments: [task.environment.id],
                        });
                        return (
                          <TableRow key={task.id} className="group">
                            <TableCell to={path}>{task.slug}</TableCell>
                            <TableCell to={path}>
                              <TaskFunctionName
                                functionName={task.exportName}
                                variant="extra-small"
                              />
                            </TableCell>
                            <TableCell to={path}>{task.filePath}</TableCell>
                            <TableCell to={path}>
                              <EnvironmentLabel
                                environment={task.environment}
                                userName={usernameForEnv}
                              />
                            </TableCell>

                            <TableCell to={path}>
                              {task.latestRun ? (
                                <div
                                  className={cn(
                                    "flex items-center gap-2",
                                    classForTaskRunStatus(task.latestRun.status)
                                  )}
                                >
                                  <DateTime date={task.latestRun.createdAt} />
                                </div>
                              ) : (
                                "Never run"
                              )}
                            </TableCell>
                            <TableCell to={path}>
                              {task.latestRun ? (
                                <TaskRunStatusCombo status={task.latestRun.status} />
                              ) : (
                                "–"
                              )}
                            </TableCell>
                            <TableCell to={path}>
                              <DateTime date={task.createdAt} />
                            </TableCell>
                            <TableCellChevron to={path} />
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableBlankRow colSpan={6}>
                        <Paragraph variant="small" className="flex items-center justify-center">
                          No tasks match your filters
                        </Paragraph>
                      </TableBlankRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <CreateTaskInstructions />
            )}
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function classForTaskRunStatus(status: TaskRunStatus) {
  switch (status) {
    case "SYSTEM_FAILURE":
    case "COMPLETED_WITH_ERRORS":
      return "text-error";
    default:
      return "";
  }
}

function CreateTaskInstructions() {
  const devEnvironment = useDevEnvironment();
  invariant(devEnvironment, "Dev environment must be defined");
  return (
    <MainCenteredContainer className="max-w-prose">
      <div className="mb-6 flex items-center justify-between border-b">
        <Header1 spacing>Get setup in 3 minutes</Header1>
        <div className="flex items-center gap-2">
          <Feedback
            button={
              <Button variant="minimal/small" LeadingIcon={ChatBubbleLeftRightIcon}>
                I'm stuck!
              </Button>
            }
            defaultValue="help"
          />
        </div>
      </div>
      <StepNumber stepNumber="1" title="Run the CLI 'init' command in your project" />
      <StepContentContainer>
        <InitCommandV3 />
        <Paragraph spacing>
          You’ll notice a new folder in your project called{" "}
          <InlineCode variant="small">trigger</InlineCode>. We’ve added a very simple example task
          in here to help you get started.
        </Paragraph>
      </StepContentContainer>
      <StepNumber stepNumber="2" title="Run the CLI 'dev' command" />
      <StepContentContainer>
        <TriggerDevStepV3 />
      </StepContentContainer>
      <StepNumber stepNumber="3" title="Waiting for tasks" displaySpinner />
      <StepContentContainer>
        <Paragraph>This page will automatically refresh.</Paragraph>
      </StepContentContainer>
    </MainCenteredContainer>
  );
}

import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";
import { useRevalidator } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import { useEffect } from "react";
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
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TaskFunctionName, TaskPath } from "~/components/runs/v3/TaskPath";
import {
  TaskRunStatusCombo,
  TaskRunStatusIcon,
  runStatusClassNameColor,
} from "~/components/runs/v3/TaskRunStatus";
import {
  TaskTriggerSourceIcon,
  taskTriggerSourceDescription,
} from "~/components/runs/v3/TaskTriggerSource";
import { useDevEnvironment } from "~/hooks/useEnvironments";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { TaskListPresenter } from "~/presenters/v3/TaskListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3RunsPath, v3TasksStreamingPath } from "~/utils/pathBuilder";

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

  //live reload the page when the tasks change
  const revalidator = useRevalidator();
  const streamedEvents = useEventSource(v3TasksStreamingPath(organization, project), {
    event: "message",
  });

  useEffect(() => {
    if (streamedEvents !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [streamedEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
      </NavBar>
      <PageBody>
        <div className={cn("grid h-full grid-cols-1 gap-4")}>
          <div className="h-full">
            {hasTasks ? (
              <div className="flex flex-col gap-4 pb-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Task ID</TableHeaderCell>
                      <TableHeaderCell>Task</TableHeaderCell>
                      <TableHeaderCell>Path</TableHeaderCell>
                      <TableHeaderCell>Environments</TableHeaderCell>
                      <TableHeaderCell>Last run</TableHeaderCell>
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.length > 0 ? (
                      tasks.map((task) => {
                        const path = v3RunsPath(organization, project, {
                          tasks: [task.slug],
                        });
                        return (
                          <TableRow key={task.slug} className="group">
                            <TableCell to={path}>
                              <div className="flex items-center gap-2">
                                <SimpleTooltip
                                  button={<TaskTriggerSourceIcon source={task.triggerSource} />}
                                  content={taskTriggerSourceDescription(task.triggerSource)}
                                />
                                <span>{task.slug}</span>
                              </div>
                            </TableCell>
                            <TableCell to={path}>
                              <TaskFunctionName
                                functionName={task.exportName}
                                variant="extra-small"
                              />
                            </TableCell>
                            <TableCell to={path}>{task.filePath}</TableCell>
                            <TableCell to={path}>
                              <div className="space-x-2">
                                {task.environments.map((environment) => (
                                  <EnvironmentLabel
                                    key={environment.id}
                                    environment={environment}
                                    userName={environment.userName}
                                  />
                                ))}
                              </div>
                            </TableCell>

                            <TableCell to={path}>
                              {task.latestRun ? (
                                <div
                                  className={cn(
                                    "flex items-center gap-1",
                                    runStatusClassNameColor(task.latestRun.status)
                                  )}
                                >
                                  <TaskRunStatusIcon
                                    status={task.latestRun.status}
                                    className="h-4 w-4"
                                  />
                                  <DateTime date={task.latestRun.createdAt} />
                                </div>
                              ) : (
                                "Never run"
                              )}
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

function CreateTaskInstructions() {
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

import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";
import { useRevalidator } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { TaskRunStatus } from "@trigger.dev/database";
import { Suspense, useEffect } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, TooltipProps, XAxis, YAxis } from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { Feedback } from "~/components/Feedback";
import { InitCommandV3, TriggerDevStepV3 } from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { DateTime, formatDateTime } from "~/components/primitives/DateTime";
import { Header1, Header3 } from "~/components/primitives/Headers";
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
import { TaskFunctionName } from "~/components/runs/v3/TaskPath";
import {
  TaskRunStatusIcon,
  runStatusClassNameColor,
  runStatusTitle,
} from "~/components/runs/v3/TaskRunStatus";
import {
  TaskTriggerSourceIcon,
  taskTriggerSourceDescription,
} from "~/components/runs/v3/TaskTriggerSource";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { TaskActivity, TaskListPresenter } from "~/presenters/v3/TaskListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3RunsPath, v3TasksStreamingPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new TaskListPresenter();
    const { tasks, activity } = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
    });

    return typeddefer({
      tasks,
      activity,
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
  const { tasks, activity } = useTypedLoaderData<typeof loader>();
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
                      <TableHeaderCell>Activity (7d)</TableHeaderCell>
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
                            <TableCell to={path} className="p-0">
                              <Suspense fallback={<></>}>
                                <TypedAwait resolve={activity}>
                                  {(data) => {
                                    const taskData = data[task.slug];
                                    return (
                                      <>
                                        {taskData !== undefined ? (
                                          <div className="h-6 w-[5.125rem] rounded-sm">
                                            <TaskActivityGraph activity={taskData} />
                                          </div>
                                        ) : (
                                          "No activity"
                                        )}
                                      </>
                                    );
                                  }}
                                </TypedAwait>
                              </Suspense>
                            </TableCell>
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

function TaskActivityGraph({ activity }: { activity: TaskActivity }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={activity}
        margin={{
          top: 0,
          right: 0,
          left: 0,
          bottom: 0,
        }}
        width={82}
        height={24}
      >
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.05)" }}
          content={<CustomTooltip />}
          allowEscapeViewBox={{ x: true, y: true }}
          wrapperStyle={{ zIndex: 1000 }}
        />
        <Bar dataKey="bg" background={{ fill: "#212327" }} stackId="a" />
        <Bar dataKey="PENDING" fill="#5F6570" stackId="a" />
        <Bar dataKey="WAITING_FOR_DEPLOY" fill="#FBBF24" stackId="a" />
        <Bar dataKey="EXECUTING" fill="#3B82F6" stackId="a" />
        <Bar dataKey="RETRYING_AFTER_FAILURE" fill="#3B82F6" stackId="a" />
        <Bar dataKey="WAITING_TO_RESUME" fill="#3B82F6" stackId="a" />
        <Bar dataKey="COMPLETED_SUCCESSFULLY" fill="#28BF5C" stackId="a" />
        <Bar dataKey="CANCELED" fill="#5F6570" stackId="a" />
        <Bar dataKey="COMPLETED_WITH_ERRORS" fill="#F43F5E" stackId="a" />
        <Bar dataKey="INTERRUPTED" fill="#F43F5E" stackId="a" />
        <Bar dataKey="SYSTEM_FAILURE" fill="#F43F5E" stackId="a" />
        <Bar dataKey="PAUSED" fill="#FBBF24" stackId="a" />
        <Bar dataKey="CRASHED" fill="#F43F5E" stackId="a" />
      </BarChart>
    </ResponsiveContainer>
  );
}

const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (active && payload) {
    const items = payload.map((p) => ({
      label: runStatusTitle(p.dataKey as TaskRunStatus),
      value: p.value,
    }));
    const title = payload[0].payload.day as string;
    const formattedDate = formatDateTime(new Date(title), "UTC", [], false, false);
    return (
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 spacing>{formattedDate}</Header3>
        <div className="flex flex-col gap-1">
          {items.map((item) => (
            <div key={item.label} className="flex gap-1 text-xs text-text-bright">
              <p>{item.label}:</p>
              <p>{item.value}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
};

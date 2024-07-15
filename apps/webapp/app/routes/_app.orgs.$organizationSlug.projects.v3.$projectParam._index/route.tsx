import { ChatBubbleLeftRightIcon, ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/20/solid";
import { useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import { type TaskRunStatus } from "@trigger.dev/database";
import { Fragment, Suspense, useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, type TooltipProps } from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { Feedback } from "~/components/Feedback";
import { InitCommandV3, TriggerDevStepV3, TriggerLoginStepV3 } from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabels } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header1, Header2, Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Property, PropertyTable } from "~/components/primitives/PropertyTable";
import { Spinner } from "~/components/primitives/Spinner";
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
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { TaskFunctionName } from "~/components/runs/v3/TaskPath";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import {
  TaskTriggerSourceIcon,
  taskTriggerSourceDescription,
} from "~/components/runs/v3/TaskTriggerSource";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTextFilter } from "~/hooks/useTextFilter";
import { type Task, type TaskActivity, TaskListPresenter } from "~/presenters/v3/TaskListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3RunsPath, v3TasksStreamingPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new TaskListPresenter();
    const { tasks, userHasTasks, activity, runningStats, durations } = await presenter.call({
      userId,
      organizationSlug,
      projectSlug: projectParam,
    });

    return typeddefer({
      tasks,
      userHasTasks,
      activity,
      runningStats,
      durations,
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
  const { tasks, userHasTasks, activity, runningStats, durations } =
    useTypedLoaderData<typeof loader>();
  const { filterText, setFilterText, filteredItems } = useTextFilter<Task>({
    items: tasks,
    filter: (task, text) => {
      if (task.slug.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (
        task.exportName.toLowerCase().includes(text.toLowerCase().replace("(", "").replace(")", ""))
      ) {
        return true;
      }

      if (task.filePath.toLowerCase().includes(text.toLowerCase())) {
        return true;
      }

      if (task.triggerSource === "SCHEDULED" && "scheduled".includes(text.toLowerCase())) {
        return true;
      }

      return false;
    },
  });

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
        <PageAccessories>
          <AdminDebugTooltip>
            <PropertyTable>
              {tasks.map((task) => (
                <Property label={task.exportName} key={task.slug}>
                  <div className="flex items-center gap-2">
                    <Paragraph variant="extra-small/bright/mono">
                      {task.environments
                        .map((e) =>
                          e.userName ? `${e.userName}/${e.id}` : `${e.type.slice(0, 3)}/${e.id}`
                        )
                        .join(", ")}
                    </Paragraph>
                  </div>
                </Property>
              ))}
            </PropertyTable>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className={cn("grid h-full grid-rows-1")}>
          {hasTasks ? (
            <div className="flex flex-col gap-4 pb-4">
              {!userHasTasks && <UserHasNoTasks />}
              <div className="pb-4">
                <div className="h-8">
                  <Input
                    placeholder="Search tasks"
                    variant="tertiary"
                    icon="search"
                    fullWidth={true}
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    autoFocus
                  />
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Task ID</TableHeaderCell>
                      <TableHeaderCell>Task</TableHeaderCell>
                      <TableHeaderCell>Running</TableHeaderCell>
                      <TableHeaderCell>Queued</TableHeaderCell>
                      <TableHeaderCell>Activity (7d)</TableHeaderCell>
                      <TableHeaderCell>Avg. duration</TableHeaderCell>
                      <TableHeaderCell>Environments</TableHeaderCell>
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredItems.length > 0 ? (
                      filteredItems.map((task) => {
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
                            <TableCell to={path} className="py-0" actionClassName="py-0">
                              <TaskFunctionName
                                functionName={task.exportName}
                                variant="extra-extra-small"
                              />
                            </TableCell>
                            <TableCell to={path} className="p-0">
                              <Suspense
                                fallback={
                                  <>
                                    <Spinner color="muted" />
                                  </>
                                }
                              >
                                <TypedAwait resolve={runningStats}>
                                  {(data) => {
                                    const taskData = data[task.slug];
                                    return taskData?.running ?? "0";
                                  }}
                                </TypedAwait>
                              </Suspense>
                            </TableCell>
                            <TableCell to={path} className="p-0">
                              <Suspense fallback={<></>}>
                                <TypedAwait resolve={runningStats}>
                                  {(data) => {
                                    const taskData = data[task.slug];
                                    return taskData?.queued ?? "0";
                                  }}
                                </TypedAwait>
                              </Suspense>
                            </TableCell>
                            <TableCell to={path} className="p-0" actionClassName="py-0">
                              <Suspense fallback={<TaskActivityBlankState />}>
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
                                          <TaskActivityBlankState />
                                        )}
                                      </>
                                    );
                                  }}
                                </TypedAwait>
                              </Suspense>
                            </TableCell>
                            <TableCell to={path} className="p-0">
                              <Suspense fallback={<></>}>
                                <TypedAwait resolve={durations}>
                                  {(data) => {
                                    const taskData = data[task.slug];
                                    return taskData
                                      ? formatDurationMilliseconds(taskData * 1000, {
                                          style: "short",
                                        })
                                      : "–";
                                  }}
                                </TypedAwait>
                              </Suspense>
                            </TableCell>
                            <TableCell to={path}>
                              <EnvironmentLabels environments={task.environments} />
                            </TableCell>
                            <TableCellChevron to={path} />
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableBlankRow colSpan={8}>
                        <Paragraph variant="small" className="flex items-center justify-center">
                          No tasks match your filters
                        </Paragraph>
                      </TableBlankRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : (
            <MainCenteredContainer className="max-w-prose">
              <CreateTaskInstructions />
            </MainCenteredContainer>
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

function CreateTaskInstructions() {
  return (
    <div>
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
    </div>
  );
}

function UserHasNoTasks() {
  const [open, setOpen] = useState(false);

  return (
    <Callout
      variant="info"
      cta={
        <Button
          variant="tertiary/small"
          TrailingIcon={open ? ChevronUpIcon : ChevronDownIcon}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Close" : "Setup your dev environment"}
        </Button>
      }
    >
      {open ? (
        <div>
          <Header2 spacing>Get setup in 3 minutes</Header2>

          <StepNumber stepNumber="1" title="Open up your project" className="mt-6" />
          <StepContentContainer>
            <Paragraph>You'll need to open a terminal at the root of your project.</Paragraph>
          </StepContentContainer>
          <StepNumber stepNumber="2" title="Run the CLI 'login' command" />
          <StepContentContainer>
            <TriggerLoginStepV3 />
          </StepContentContainer>
          <StepNumber stepNumber="3" title="Run the CLI 'dev' command" />
          <StepContentContainer>
            <TriggerDevStepV3 />
          </StepContentContainer>
          <StepNumber stepNumber="4" title="Waiting for tasks" displaySpinner />
          <StepContentContainer>
            <Paragraph>This page will automatically refresh.</Paragraph>
          </StepContentContainer>
        </div>
      ) : (
        "Your DEV environment isn't setup yet."
      )}
    </Callout>
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
          cursor={{ fill: "transparent" }}
          content={<CustomTooltip />}
          allowEscapeViewBox={{ x: true, y: true }}
          wrapperStyle={{ zIndex: 1000 }}
          animationDuration={0}
        />

        {/* The background */}
        <Bar
          dataKey="bg"
          background={{ fill: "#212327" }}
          strokeWidth={0}
          stackId="a"
          barSize={10}
          isAnimationActive={false}
        />
        <Bar dataKey="PENDING" fill="#5F6570" stackId="a" strokeWidth={0} barSize={10} />
        <Bar dataKey="WAITING_FOR_DEPLOY" fill="#F59E0B" stackId="a" strokeWidth={0} barSize={10} />
        <Bar dataKey="EXECUTING" fill="#3B82F6" stackId="a" strokeWidth={0} barSize={10} />
        <Bar
          dataKey="RETRYING_AFTER_FAILURE"
          fill="#3B82F6"
          stackId="a"
          strokeWidth={0}
          barSize={10}
        />
        <Bar dataKey="WAITING_TO_RESUME" fill="#3B82F6" stackId="a" strokeWidth={0} barSize={10} />
        <Bar
          dataKey="COMPLETED_SUCCESSFULLY"
          fill="#28BF5C"
          stackId="a"
          strokeWidth={0}
          barSize={10}
        />
        <Bar dataKey="CANCELED" fill="#5F6570" stackId="a" strokeWidth={0} barSize={10} />
        <Bar
          dataKey="COMPLETED_WITH_ERRORS"
          fill="#F43F5E"
          stackId="a"
          strokeWidth={0}
          barSize={10}
        />
        <Bar dataKey="INTERRUPTED" fill="#F43F5E" stackId="a" strokeWidth={0} barSize={10} />
        <Bar dataKey="SYSTEM_FAILURE" fill="#F43F5E" stackId="a" strokeWidth={0} barSize={10} />
        <Bar dataKey="PAUSED" fill="#FCD34D" stackId="a" strokeWidth={0} barSize={10} />
        <Bar dataKey="CRASHED" fill="#F43F5E" stackId="a" strokeWidth={0} barSize={10} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function TaskActivityBlankState() {
  return (
    <div className="flex h-6 w-[5.125rem] items-center gap-0.5 rounded-sm">
      {[...Array(7)].map((_, i) => (
        <div key={i} className="h-full w-2.5 bg-[#212327]" />
      ))}
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (active && payload) {
    const items = payload.map((p) => ({
      status: p.dataKey as TaskRunStatus,
      value: p.value,
    }));
    const title = payload[0].payload.day as string;
    const formattedDate = formatDateTime(new Date(title), "UTC", [], false, false);

    return (
      <TooltipPortal active={active}>
        <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
          <Header3 className="border-b-charcoal-650 border-b pb-2">{formattedDate}</Header3>
          <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 text-xs text-text-bright">
            {items.map((item) => (
              <Fragment key={item.status}>
                <TaskRunStatusCombo status={item.status} />
                <p>{item.value}</p>
              </Fragment>
            ))}
          </div>
        </div>
      </TooltipPortal>
    );
  }

  return null;
};

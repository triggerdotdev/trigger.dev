import {
  BeakerIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LightBulbIcon,
  UserPlusIcon,
} from "@heroicons/react/20/solid";
import { Link, useRevalidator } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { TaskRunStatus } from "@trigger.dev/database";
import { Fragment, Suspense, useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, TooltipProps } from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { SideMenuRightClosedIcon } from "~/assets/icons/SideMenuRightClosed";
import { Feedback } from "~/components/Feedback";
import { InitCommandV3, TriggerDevStepV3, TriggerLoginStepV3 } from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabels } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header1, Header2, Header3 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import { StepNumber } from "~/components/primitives/StepNumber";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { TaskFunctionName } from "~/components/runs/v3/TaskPath";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import {
  taskTriggerSourceDescription,
  TaskTriggerSourceIcon,
} from "~/components/runs/v3/TaskTriggerSource";
import { useEventSource } from "~/hooks/useEventSource";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useTextFilter } from "~/hooks/useTextFilter";
import { Task, TaskActivity, TaskListPresenter } from "~/presenters/v3/TaskListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  inviteTeamMemberPath,
  ProjectParamSchema,
  v3RunsPath,
  v3TasksStreamingPath,
  v3TestPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";
import videoThumbFalRealtime from "~/assets/images/video-thumb-fal-realtime.jpg";
import testTaskLink from "~/assets/images/test-task-link.png";

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

  const [showQuickStart, setShowQuickStart] = useState(true);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {tasks.map((task) => (
                <Property.Item key={task.slug}>
                  <Property.Label>{task.exportName}</Property.Label>
                  <Property.Value>
                    {task.environments
                      .map((e) =>
                        e.userName ? `${e.userName}/${e.id}` : `${e.type.slice(0, 3)}/${e.id}`
                      )
                      .join(", ")}
                  </Property.Value>
                </Property.Item>
              ))}
            </Property.Table>
          </AdminDebugTooltip>
          <LinkButton
            variant={"docs/small"}
            LeadingIcon={BookOpenIcon}
            to={docsPath("/tasks/overview")}
          >
            Task docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="tasks-main" className="max-h-full">
            <div className={cn("grid h-full grid-rows-1")}>
              {hasTasks ? (
                <div className="flex min-w-0 max-w-full flex-col">
                  {!userHasTasks && <UserHasNoTasks />}
                  <div className="max-h-full overflow-hidden">
                    <div className="flex items-center p-2">
                      <Input
                        placeholder="Search tasks"
                        variant="tertiary"
                        icon="search"
                        fullWidth={true}
                        value={filterText}
                        onChange={(e) => setFilterText(e.target.value)}
                        autoFocus
                      />
                      {!showQuickStart && (
                        <Button
                          variant="minimal/small"
                          TrailingIcon={LightBulbIcon}
                          onClick={() => setShowQuickStart(true)}
                          className="px-2.5"
                        />
                      )}
                    </div>
                    <Table containerClassName="max-h-full pb-[2.5rem]">
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

                            const devYouEnvironment = task.environments.find(
                              (e) => e.type === "DEVELOPMENT" && !e.userName
                            );
                            const firstDeployedEnvironment = task.environments
                              .filter((e) => e.type !== "DEVELOPMENT")
                              .at(0);
                            const testEnvironment = devYouEnvironment ?? firstDeployedEnvironment;

                            const testPath = testEnvironment
                              ? v3TestTaskPath(
                                  organization,
                                  project,
                                  { taskIdentifier: task.slug },
                                  testEnvironment.slug
                                )
                              : v3TestPath(organization, project);

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
                                <TableCellMenu
                                  isSticky
                                  popoverContent={
                                    <>
                                      <PopoverMenuItem
                                        icon="runs"
                                        to={path}
                                        title="View runs"
                                        leadingIconClassName="text-teal-500"
                                      />
                                      <PopoverMenuItem
                                        icon="beaker"
                                        to={testPath}
                                        title="Test task"
                                      />
                                    </>
                                  }
                                  hiddenButtons={
                                    <LinkButton
                                      variant="minimal/small"
                                      LeadingIcon={BeakerIcon}
                                      leadingIconClassName="text-text-bright"
                                      to={testPath}
                                    >
                                      Test
                                    </LinkButton>
                                  }
                                />
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
          </ResizablePanel>
          {hasTasks && showQuickStart ? (
            <>
              <ResizableHandle id="tasks-handle" />
              <ResizablePanel
                id="tasks-inspector"
                min="200px"
                default="600px"
                max="1000px"
                className="w-full"
              >
                <HelpfulInfoHasTasks onClose={() => setShowQuickStart(false)} />
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
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
    <div className="px-2 pt-2">
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
    </div>
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
          <Header3 className="border-b border-b-charcoal-650 pb-2">{formattedDate}</Header3>
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

function HelpfulInfoHasTasks({ onClose }: { onClose: () => void }) {
  const organization = useOrganization();

  return (
    <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed py-2">
        <Header2 className="flex items-center gap-2">
          <LightBulbIcon className="size-4 text-sun-500" />
          Helpful next steps
        </Header2>
        <Button
          onClick={onClose}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-[0.375rem]"
        />
      </div>
      <div className="overflow-y-scroll p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <StepNumber stepNumber="1" title="Test your task" />
        <StepContentContainer>
          <Paragraph spacing>
            Test your tasks by clicking the "Test" button in the task list, in the side menu or by
            clicking this button.
          </Paragraph>
          <div className="aspect-video w-full flex-shrink-0 overflow-hidden rounded-sm">
            <img src={testTaskLink} alt="Test your task" className="size-full object-cover" />
          </div>
        </StepContentContainer>
        <StepNumber stepNumber="2" title="Create a new task from examples" />
        <StepContentContainer className="flex flex-col gap-3">
          <ExampleTaskCard
            slug="fal-ai-realtime"
            description="Generate an image from a prompt using Fal.ai and Realtime."
            alt="Fal.ai with Trigger.dev Realtime"
            src={videoThumbFalRealtime}
          />
          <ExampleTaskCard
            slug="fal-ai-realtime"
            description="Generate an image from a prompt using Fal.ai and Realtime."
            alt="Fal.ai with Trigger.dev Realtime"
            src={videoThumbFalRealtime}
          />
        </StepContentContainer>
        <StepNumber stepNumber="3" title="Invite team members" />
        <StepContentContainer>
          <Paragraph spacing>
            Invite team members to your project to collaborate on building tasks.
          </Paragraph>
          <LinkButton
            to={inviteTeamMemberPath(organization)}
            variant={"secondary/small"}
            LeadingIcon={UserPlusIcon}
          >
            Invite team members
          </LinkButton>
        </StepContentContainer>
        <StepNumber stepNumber="4" title="Need help getting started?" />
        <StepContentContainer>
          <Paragraph spacing>Get in touch with us for help getting started.</Paragraph>
          <Feedback
            button={
              <Button variant="secondary/small" LeadingIcon={ChatBubbleLeftRightIcon}>
                Get in touch
              </Button>
            }
            defaultValue="help"
          />
        </StepContentContainer>
      </div>
    </div>
  );
}

function ExampleTaskCard({
  slug,
  description,
  alt,
  src,
}: {
  slug: string;
  description: string;
  alt: string;
  src: string;
}) {
  return (
    <Link
      to={docsPath(`/guides/examples/${slug}`)}
      target="_blank"
      rel="noreferrer"
      className="flex w-fit items-center gap-2 rounded border border-grid-bright py-1 pl-1 pr-3 transition hover:border-charcoal-600"
    >
      <div className="aspect-video h-12 max-w-full flex-shrink-0 overflow-hidden rounded-sm">
        <img src={src} alt={alt} className="size-full object-cover" />
      </div>
      <Paragraph>{description}</Paragraph>
    </Link>
  );
}

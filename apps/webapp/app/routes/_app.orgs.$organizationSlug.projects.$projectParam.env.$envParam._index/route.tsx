import {
  BeakerIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LightBulbIcon,
  MagnifyingGlassIcon,
  UserPlusIcon,
  VideoCameraIcon,
} from "@heroicons/react/20/solid";
import { json, type MetaFunction } from "@remix-run/node";
import { Link, useRevalidator, useSubmit } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { DiscordIcon } from "@trigger.dev/companyicons";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { type TaskRunStatus } from "@trigger.dev/database";
import { Fragment, Suspense, useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, type TooltipProps } from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { HasNoTasksDeployed, HasNoTasksDev } from "~/components/BlankStatePanels";
import {
  PackageManagerProvider,
  TriggerDevStepV3,
  TriggerLoginStepV3,
} from "~/components/SetupCommands";
import { StepContentContainer } from "~/components/StepContentContainer";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { AnimatingArrow } from "~/components/primitives/AnimatingArrow";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/primitives/Dialog";
import { Header2, Header3 } from "~/components/primitives/Headers";
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
import { TaskFileName } from "~/components/runs/v3/TaskPath";
import { TaskRunStatusCombo } from "~/components/runs/v3/TaskRunStatus";
import {
  taskTriggerSourceDescription,
  TaskTriggerSourceIcon,
} from "~/components/runs/v3/TaskTriggerSource";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useFuzzyFilter } from "~/hooks/useFuzzyFilter";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type TaskActivity,
  type TaskListItem,
  TaskListPresenter,
} from "~/presenters/v3/TaskListPresenter.server";
import {
  getUsefulLinksPreference,
  setUsefulLinksPreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  docsPath,
  EnvironmentParamSchema,
  inviteTeamMemberPath,
  v3RunsPath,
  v3TasksStreamingPath,
  v3TestPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Tasks | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

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

  try {
    const presenter = new TaskListPresenter();
    const { tasks, activity, runningStats, durations } = await presenter.call({
      environmentId: environment.id,
      projectId: project.id,
    });

    const usefulLinksPreference = await getUsefulLinksPreference(request);

    return typeddefer({
      tasks,
      activity,
      runningStats,
      durations,
      usefulLinksPreference,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const showUsefulLinks = formData.get("showUsefulLinks") === "true";

  const session = await setUsefulLinksPreference(showUsefulLinks, request);

  return json(
    { success: true },
    {
      headers: {
        "Set-Cookie": await uiPreferencesStorage.commitSession(session),
      },
    }
  );
}

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { tasks, activity, runningStats, durations, usefulLinksPreference } =
    useTypedLoaderData<typeof loader>();
  const { filterText, setFilterText, filteredItems } = useFuzzyFilter<TaskListItem>({
    items: tasks,
    keys: ["slug", "filePath", "triggerSource"],
  });

  const hasTasks = tasks.length > 0;

  //live reload the page when the tasks change
  const revalidator = useRevalidator();
  const streamedEvents = useEventSource(v3TasksStreamingPath(organization, project, environment), {
    event: "message",
  });

  useEffect(() => {
    if (streamedEvents !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [streamedEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  const [showUsefulLinks, setShowUsefulLinks] = useState(usefulLinksPreference ?? true);

  // Create a submit handler to save the preference
  const submit = useSubmit();

  const handleUsefulLinksToggle = (show: boolean) => {
    setShowUsefulLinks(show);
    submit({ showUsefulLinks: show.toString() }, { method: "post" });
  };

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              {tasks.map((task) => (
                <Property.Item key={task.slug}>
                  <Property.Label>{task.filePath}</Property.Label>
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
                  {tasks.length === 0 ? <UserHasNoTasks /> : null}
                  <div className="max-h-full overflow-hidden">
                    <div className="flex items-center gap-1 p-2">
                      <Input
                        placeholder="Search tasks"
                        variant="tertiary"
                        icon={MagnifyingGlassIcon}
                        fullWidth={true}
                        value={filterText}
                        onChange={(e) => setFilterText(e.target.value)}
                        autoFocus
                      />
                      {!showUsefulLinks && (
                        <Button
                          variant="minimal/small"
                          TrailingIcon={LightBulbIcon}
                          onClick={() => handleUsefulLinksToggle(true)}
                          className="px-2.5"
                        />
                      )}
                    </div>
                    <Table containerClassName="max-h-full pb-[2.5rem]">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Task ID</TableHeaderCell>
                          <TableHeaderCell>File</TableHeaderCell>
                          <TableHeaderCell>Running</TableHeaderCell>
                          <TableHeaderCell>Queued</TableHeaderCell>
                          <TableHeaderCell>Activity (7d)</TableHeaderCell>
                          <TableHeaderCell>Avg. duration</TableHeaderCell>
                          <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredItems.length > 0 ? (
                          filteredItems.map((task) => {
                            const path = v3RunsPath(organization, project, environment, {
                              tasks: [task.slug],
                            });

                            const testPath = v3TestTaskPath(organization, project, environment, {
                              taskIdentifier: task.slug,
                            });

                            return (
                              <TableRow key={task.slug} className="group">
                                <TableCell to={path} isTabbableCell>
                                  <div className="flex items-center gap-2">
                                    <SimpleTooltip
                                      button={<TaskTriggerSourceIcon source={task.triggerSource} />}
                                      content={taskTriggerSourceDescription(task.triggerSource)}
                                    />
                                    <span>{task.slug}</span>
                                  </div>
                                </TableCell>
                                <TableCell to={path}>
                                  <TaskFileName
                                    fileName={task.filePath}
                                    variant="extra-extra-small"
                                  />
                                </TableCell>
                                <TableCell to={path}>
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
                                <TableCell to={path}>
                                  <Suspense fallback={<></>}>
                                    <TypedAwait resolve={runningStats}>
                                      {(data) => {
                                        const taskData = data[task.slug];
                                        return taskData?.queued ?? "0";
                                      }}
                                    </TypedAwait>
                                  </Suspense>
                                </TableCell>
                                <TableCell to={path} actionClassName="py-1.5">
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
                                <TableCell to={path}>
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
                                <TableCellMenu
                                  isSticky
                                  popoverContent={
                                    <>
                                      <PopoverMenuItem
                                        icon={RunsIcon}
                                        to={path}
                                        title="View runs"
                                        leadingIconClassName="text-teal-500"
                                      />
                                      <PopoverMenuItem
                                        icon={BeakerIcon}
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
              ) : environment.type === "DEVELOPMENT" ? (
                <MainCenteredContainer className="max-w-prose">
                  <HasNoTasksDev />
                </MainCenteredContainer>
              ) : (
                <MainCenteredContainer className="max-w-md">
                  <HasNoTasksDeployed environment={environment} />
                </MainCenteredContainer>
              )}
            </div>
          </ResizablePanel>
          {hasTasks && showUsefulLinks ? (
            <>
              <ResizableHandle id="tasks-handle" />
              <ResizablePanel
                id="tasks-inspector"
                min="200px"
                default="400px"
                max="500px"
                className="w-full"
              >
                <HelpfulInfoHasTasks onClose={() => handleUsefulLinksToggle(false)} />
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
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
          <PackageManagerProvider>
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
          </PackageManagerProvider>
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
        <Bar dataKey="PENDING_VERSION" fill="#F59E0B" stackId="a" strokeWidth={0} barSize={10} />
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
        <Bar dataKey="EXPIRED" fill="#F43F5E" stackId="a" strokeWidth={0} barSize={10} />
        <Bar dataKey="TIMED_OUT" fill="#F43F5E" stackId="a" strokeWidth={0} barSize={10} />
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
  const project = useProject();
  const environment = useEnvironment();
  const [isVideoDialogOpen, setIsVideoDialogOpen] = useState(false);

  return (
    <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="overflow-y-scroll p-3 pt-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="mb-2 flex items-center justify-between gap-2 border-b border-grid-dimmed pb-2">
          <Header2 className="flex items-center gap-2">
            <LightBulbIcon className="size-4 min-w-4 text-sun-500" />
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
        <LinkWithIcon
          variant="withIcon"
          to={v3TestPath(organization, project, environment)}
          description="Test your tasks"
          icon={<BeakerIcon className="size-5 text-lime-500" />}
        />
        <LinkWithIcon
          variant="withIcon"
          to={inviteTeamMemberPath(organization)}
          description="Invite team members"
          icon={<UserPlusIcon className="size-5 text-amber-500" />}
        />
        <div
          role="button"
          onClick={() => setIsVideoDialogOpen(true)}
          className={cn(
            "group flex w-full items-center justify-between gap-2 rounded-md p-1 pr-3 transition hover:bg-charcoal-750",
            variants["withIcon"].container
          )}
        >
          <div className="flex items-center gap-2">
            <div className={variants["withIcon"].iconContainer}>
              <VideoCameraIcon className="size-5 text-rose-500" />
            </div>
            <Paragraph variant="base" className="transition-colors group-hover:text-text-bright">
              Watch a 14 min walkthrough video
            </Paragraph>
          </div>
          <AnimatingArrow direction="right" theme="dimmed" />
        </div>
        <LinkWithIcon
          variant="withIcon"
          to="https://trigger.dev/discord"
          description="Join our Discord for help and support"
          icon={<DiscordIcon className="size-5" />}
          isExternal
        />
        <div className="mb-2 flex items-center gap-2 border-b border-grid-dimmed pb-2 pt-6">
          <Header2 className="flex items-center gap-2">
            <BookOpenIcon className="size-5 text-blue-500" />
            From the docs
          </Header2>
        </div>
        <LinkWithIcon
          to={docsPath("/writing-tasks-introduction")}
          description="How to write a task"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/tasks/scheduled")}
          description="Scheduled tasks (cron)"
          isExternal
        />
        <LinkWithIcon to={docsPath("/triggering")} description="How to trigger a task" isExternal />
        <LinkWithIcon to={docsPath("/cli-dev")} description="Running the CLI" isExternal />
        <LinkWithIcon
          to={docsPath("/how-it-works")}
          description="How Trigger.dev works"
          isExternal
        />
        <div className="mb-2 flex items-center gap-2 border-b border-grid-dimmed pb-2 pt-6">
          <Header2 className="flex items-center gap-2">
            <TaskIcon className="size-5 text-blue-500" />
            Example tasks
          </Header2>
        </div>
        <LinkWithIcon
          to={docsPath("/examples/dall-e3-generate-image")}
          description="DALL·E 3 image generation"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/deepgram-transcribe-audio")}
          description="Deepgram audio transcription"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/fal-ai-image-to-cartoon")}
          description="Fal.ai image to cartoon"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/fal-ai-realtime")}
          description="Fal.ai with Realtime"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/ffmpeg-video-processing")}
          description="FFmpeg video processing"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/firecrawl-url-crawl")}
          description="Firecrawl URL crawl"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/libreoffice-pdf-conversion")}
          description="LibreOffice PDF conversion"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/open-ai-with-retrying")}
          description="OpenAI with retrying"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/pdf-to-image")}
          description="PDF to image"
          isExternal
        />
        <LinkWithIcon to={docsPath("/examples/puppeteer")} description="Puppeteer" isExternal />
        <LinkWithIcon to={docsPath("/examples/react-pdf")} description="React to PDF" isExternal />
        <LinkWithIcon
          to={docsPath("/examples/resend-email-sequence")}
          description="Resend email sequence"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/scrape-hacker-news")}
          description="Scrape Hacker News"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/sentry-error-tracking")}
          description="Sentry error tracking"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/sharp-image-processing")}
          description="Sharp image processing"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/supabase-database-operations")}
          description="Supabase database operations"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/supabase-storage-upload")}
          description="Supabase Storage upload"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/vercel-ai-sdk")}
          description="Vercel AI SDK"
          isExternal
        />
        <LinkWithIcon
          to={docsPath("/examples/vercel-sync-env-vars")}
          description="Vercel sync environment variables"
          isExternal
        />
      </div>
      <Dialog open={isVideoDialogOpen} onOpenChange={setIsVideoDialogOpen}>
        <DialogContent className="sm:max-w-screen-lg">
          <DialogHeader className="mb-4 pt-1">
            <DialogTitle>Trigger.dev walkthrough</DialogTitle>
          </DialogHeader>
          <div className="aspect-video">
            <iframe
              width="100%"
              height="100%"
              src="https://www.youtube.com/embed/YH_4c0K7fGM?si=BcX6MAt_V139sRw9"
              title="Trigger.dev walkthrough"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const variants = {
  withIcon: {
    container: "",
    iconContainer:
      "grid size-9 min-w-9 place-items-center rounded border border-transparent bg-charcoal-750 shadow transition group-hover:border-charcoal-650",
  },
  minimal: {
    container: "pl-3 py-2",
    iconContainer: "",
  },
} as const;

type LinkWithIconProps = {
  to: string;
  description: string;
  icon?: React.ReactNode;
  isExternal?: boolean;
  variant?: keyof typeof variants;
};

function LinkWithIcon({
  to,
  description,
  icon,
  isExternal,
  variant = "minimal",
}: LinkWithIconProps) {
  const variation = variants[variant];

  return (
    <Link
      to={to}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noreferrer" : undefined}
      className={cn(
        "group flex w-full items-center justify-between gap-2 rounded-md p-1 pr-3 transition hover:bg-charcoal-750",
        variation.container
      )}
    >
      <div className="flex items-center gap-2">
        {variant === "withIcon" && icon && <div className={variation.iconContainer}>{icon}</div>}
        <Paragraph variant="base" className="transition-colors group-hover:text-text-bright">
          {description}
        </Paragraph>
      </div>
      <AnimatingArrow direction={isExternal ? "topRight" : "right"} theme="dimmed" />
    </Link>
  );
}

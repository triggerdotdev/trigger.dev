import { BookOpenIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { json, type MetaFunction } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { TaskRunStatus } from "@trigger.dev/database";
import type { PanelHandle } from "@window-splitter/react";
import { Fragment, Suspense, useCallback, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  YAxis,
} from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { HasNoTasksDeployed, HasNoTasksDev } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { PaginationControls } from "~/components/primitives/Pagination";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
} from "~/components/primitives/Resizable";
import { SearchInput } from "~/components/primitives/SearchInput";
import {
  ComboboxProvider,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
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
import { TaskTriggerSourceIcon } from "~/components/runs/v3/TaskTriggerSource";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFuzzyFilter } from "~/hooks/useFuzzyFilter";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  getUsefulLinksPreference,
  setUsefulLinksPreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import {
  unifiedTaskListPresenter,
  type HourlyTaskActivity,
  type UnifiedRunningState,
  type UnifiedRunningStates,
  type UnifiedTaskKind,
  type UnifiedTaskListItem,
} from "~/presenters/v3/UnifiedTaskListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatNumberCompact } from "~/utils/numberFormatter";
import {
  docsPath,
  EnvironmentParamSchema,
  v3AgentTaskPath,
  v3PlaygroundAgentPath,
  v3RunsPath,
  v3ScheduledTaskPath,
  v3StandardTaskPath,
  v3TestTaskPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [{ title: `Tasks | Trigger.dev` }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, { status: 404, statusText: "Project not found" });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, { status: 404, statusText: "Environment not found" });
  }

  try {
    const { items, hourlyActivity, runningStates } = await unifiedTaskListPresenter.call({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      environmentType: environment.type,
    });

    const usefulLinksPreference = await getUsefulLinksPreference(request);

    return typeddefer({ items, hourlyActivity, runningStates, usefulLinksPreference });
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

const KIND_OPTIONS: { value: UnifiedTaskKind; label: string }[] = [
  { value: "AGENT", label: "Agent tasks" },
  { value: "STANDARD", label: "Standard tasks" },
  { value: "SCHEDULED", label: "Scheduled tasks" },
];

const PAGE_SIZE = 25;

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { items, hourlyActivity, runningStates, usefulLinksPreference } =
    useTypedLoaderData<typeof loader>();
  const { value, values } = useSearchParams();

  const [showUsefulLinks, setShowUsefulLinks] = useState(usefulLinksPreference ?? true);
  const usefulLinksPanelRef = useRef<PanelHandle>(null);
  const fetcher = useFetcher();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const toggleUsefulLinks = useCallback((show: boolean) => {
    setShowUsefulLinks(show);
    if (show) {
      usefulLinksPanelRef.current?.expand();
    } else {
      usefulLinksPanelRef.current?.collapse();
    }
    fetcherRef.current.submit({ showUsefulLinks: show.toString() }, { method: "post" });
  }, []);

  const selectedTypes = useMemo(() => {
    const raw = values("types") as UnifiedTaskKind[];
    return raw.length > 0 ? new Set(raw) : null; // null = all
  }, [values]);

  const { filteredItems } = useFuzzyFilter<UnifiedTaskListItem>({
    items,
    keys: ["slug", "filePath", "triggerSource"],
    filterText: value("search") ?? "",
  });

  const visibleItems = useMemo(() => {
    if (!selectedTypes) return filteredItems;
    return filteredItems.filter((item) => selectedTypes.has(item.kind));
  }, [filteredItems, selectedTypes]);

  const hasItems = items.length > 0;

  // Client-side pagination. The presenter returns every task because the
  // search + type filter run client-side too, but we only render PAGE_SIZE
  // rows at a time. Clamps to the last page if the requested one is past
  // the end (e.g. after a search narrows the result set).
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / PAGE_SIZE));
  const requestedPage = Math.max(1, parseInt(value("page") ?? "1", 10) || 1);
  const currentPage = Math.min(requestedPage, totalPages);
  const pagedItems = useMemo(
    () => visibleItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [visibleItems, currentPage]
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Tasks" />
        <PageAccessories>
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
          <ResizablePanel id="tasks-main" min="100px" className="max-h-full">
            <div className={cn("grid h-full grid-rows-1")}>
              {hasItems ? (
                <div className="flex min-w-0 max-w-full flex-col">
                  <div className="max-h-full overflow-hidden">
                    <div className="flex items-center justify-between gap-1.5 p-2">
                      <div className="flex flex-1 items-center gap-1.5">
                        <SearchInput placeholder="Search tasks…" autoFocus resetParams={["page"]} />
                        <TaskTypeFilter />
                      </div>
                      <div className="flex items-center gap-1.5">
                        {!showUsefulLinks && (
                          <Button
                            variant="primary/small"
                            LeadingIcon={PlusIcon}
                            leadingIconClassName="-mr-[0.7rem]"
                            onClick={() => toggleUsefulLinks(true)}
                            className="pl-1.5"
                          >
                            New task
                          </Button>
                        )}
                        <PaginationControls
                          currentPage={currentPage}
                          totalPages={totalPages}
                          showPageNumbers={false}
                        />
                      </div>
                    </div>
                    <Table containerClassName="max-h-full">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Task type</TableHeaderCell>
                          <TableHeaderCell>Task ID</TableHeaderCell>
                          <TableHeaderCell>File</TableHeaderCell>
                          <TableHeaderCell>Running</TableHeaderCell>
                          <TableHeaderCell>Activity (24h)</TableHeaderCell>
                          <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pagedItems.length > 0 ? (
                          pagedItems.map((item) => (
                            <TaskRow
                              key={item.slug}
                              item={item}
                              runningStates={runningStates}
                              hourlyActivity={hourlyActivity}
                              organization={organization}
                              project={project}
                              environment={environment}
                            />
                          ))
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
                </div>
              ) : environment.type === "DEVELOPMENT" ? (
                <MainCenteredContainer className="max-w-prose">
                  <HasNoTasksDev />
                </MainCenteredContainer>
              ) : (
                <MainCenteredContainer className="max-w-prose">
                  <HasNoTasksDeployed environment={environment} />
                </MainCenteredContainer>
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle
            id="tasks-handle"
            className={collapsibleHandleClassName(hasItems && showUsefulLinks)}
          />
          <ResizablePanel
            id="tasks-inspector"
            handle={usefulLinksPanelRef}
            default="400px"
            min="400px"
            max="500px"
            className="overflow-hidden"
            collapsible
            collapsed={!hasItems || !showUsefulLinks}
            onCollapseChange={() => {}}
            collapsedSize="0px"
            collapseAnimation={RESIZABLE_PANEL_ANIMATION}
          >
            <div className="h-full" style={{ minWidth: 400 }}>
              {hasItems && <NewTaskPromptsPanel onClose={() => toggleUsefulLinks(false)} />}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </PageContainer>
  );
}

type TaskRowProps = {
  item: UnifiedTaskListItem;
  runningStates: Promise<UnifiedRunningStates>;
  hourlyActivity: Promise<HourlyTaskActivity>;
  organization: ReturnType<typeof useOrganization>;
  project: ReturnType<typeof useProject>;
  environment: ReturnType<typeof useEnvironment>;
};

function TaskRow({
  item,
  runningStates,
  hourlyActivity,
  organization,
  project,
  environment,
}: TaskRowProps) {
  const rowPath =
    item.kind === "AGENT"
      ? v3AgentTaskPath(organization, project, environment, item.slug)
      : item.kind === "SCHEDULED"
      ? v3ScheduledTaskPath(organization, project, environment, item.slug)
      : v3StandardTaskPath(organization, project, environment, item.slug);

  const testPath =
    item.kind === "AGENT"
      ? v3PlaygroundAgentPath(organization, project, environment, item.slug)
      : v3TestTaskPath(organization, project, environment, { taskIdentifier: item.slug });

  const runsPath = v3RunsPath(organization, project, environment, { tasks: [item.slug] });

  return (
    <TableRow className="group">
      <TableCell to={rowPath} isTabbableCell>
        <div className="flex items-center gap-2">
          {item.kind === "AGENT" ? (
            <CubeSparkleIcon className="size-4.5 text-agents" />
          ) : (
            <TaskTriggerSourceIcon source={item.triggerSource} />
          )}
          <span>
            {item.kind === "AGENT" ? "Agent" : item.kind === "SCHEDULED" ? "Scheduled" : "Standard"}
          </span>
          {item.kind === "AGENT" && item.agentType && (
            <Badge variant="extra-small">{formatAgentType(item.agentType)}</Badge>
          )}
        </div>
      </TableCell>
      <TableCell to={rowPath}>
        <span>{item.slug}</span>
      </TableCell>
      <TableCell to={rowPath}>
        <TaskFileName fileName={item.filePath} variant="extra-extra-small" />
      </TableCell>
      <TableCell to={rowPath}>
        <Suspense fallback={<Spinner color="muted" />}>
          <TypedAwait resolve={runningStates} errorElement={<FailedToLoadStats />}>
            {(data) => <RunningCell state={data[item.slug]} />}
          </TypedAwait>
        </Suspense>
      </TableCell>
      <TableCell to={rowPath} actionClassName="py-1.5">
        <Suspense fallback={<TaskActivityBlankState />}>
          <TypedAwait resolve={hourlyActivity} errorElement={<FailedToLoadStats />}>
            {(data) => {
              const taskData = data[item.slug];
              return taskData && taskData.length > 0 ? (
                <TaskActivityGraph activity={taskData} />
              ) : (
                <TaskActivityBlankState />
              );
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
              to={runsPath}
              title="View runs"
              leadingIconClassName="-mx-1 text-runs"
            />
            <PopoverMenuItem
              icon={BeakerIcon}
              to={testPath}
              title="Test"
              leadingIconClassName="-mx-1 text-tests"
            />
          </>
        }
        hiddenButtons={
          <LinkButton
            variant="secondary/small"
            LeadingIcon={BeakerIcon}
            leadingIconClassName="-mx-2.5 text-tests"
            to={testPath}
          >
            Test
          </LinkButton>
        }
      />
    </TableRow>
  );
}

function RunningCell({ state }: { state: UnifiedRunningState | undefined }) {
  if (!state) {
    return <span className="text-text-dimmed">–</span>;
  }
  return <>{state.running ?? 0}</>;
}

function TaskTypeFilter() {
  const { values, replace } = useSearchParams();
  const raw = values("types") as UnifiedTaskKind[];
  const isAll = raw.length === 0 || raw.length === KIND_OPTIONS.length;
  // When no filter is applied, render the popover with every option preselected
  // so the user sees the "all" state and can uncheck what they don't want.
  const popoverValue = isAll ? KIND_OPTIONS.map((k) => k.value) : raw;

  const handleChange = (next: string[]) => {
    // Empty or fully-selected → clear the URL so the default (all) applies.
    // Always reset `page` since the filter change probably moves rows out from
    // under the current page.
    if (next.length === 0 || next.length === KIND_OPTIONS.length) {
      replace({ types: undefined, page: undefined });
    } else {
      replace({ types: next, page: undefined });
    }
  };

  const label = isAll
    ? "All"
    : raw.map((v) => KIND_OPTIONS.find((k) => k.value === v)?.label ?? v).join(", ");

  return (
    <ComboboxProvider>
      <SelectProvider value={popoverValue} setValue={handleChange} virtualFocus>
        <SelectTrigger variant="secondary/small" dropdownIcon>
          <span className="text-text-bright">Task type: </span>
          <span className="max-w-[180px] truncate text-text-dimmed">{label}</span>
        </SelectTrigger>
        <SelectPopover className="min-w-fit">
          <SelectList>
            {KIND_OPTIONS.map((opt, index) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
              >
                <span className="flex items-center gap-2">
                  <TaskTriggerSourceIcon source={opt.value} />
                  <span className="text-text-bright">{opt.label}</span>
                </span>
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopover>
      </SelectProvider>
    </ComboboxProvider>
  );
}

function formatAgentType(type: string): string {
  switch (type) {
    case "ai-sdk-chat":
      return "AI SDK Chat";
    default:
      return type;
  }
}

const STATUS_BARS: { status: TaskRunStatus; fill: string }[] = [
  { status: "DELAYED", fill: "#5F6570" },
  { status: "PENDING", fill: "#5F6570" },
  { status: "PENDING_VERSION", fill: "#F59E0B" },
  { status: "EXECUTING", fill: "#3B82F6" },
  { status: "RETRYING_AFTER_FAILURE", fill: "#3B82F6" },
  { status: "WAITING_TO_RESUME", fill: "#3B82F6" },
  { status: "COMPLETED_SUCCESSFULLY", fill: "#28BF5C" },
  { status: "CANCELED", fill: "#5F6570" },
  { status: "COMPLETED_WITH_ERRORS", fill: "#F43F5E" },
  { status: "INTERRUPTED", fill: "#F43F5E" },
  { status: "SYSTEM_FAILURE", fill: "#F43F5E" },
  { status: "PAUSED", fill: "#FCD34D" },
  { status: "CRASHED", fill: "#F43F5E" },
  { status: "EXPIRED", fill: "#5F6570" },
  { status: "TIMED_OUT", fill: "#F43F5E" },
];

function TaskActivityGraph({ activity }: { activity: HourlyTaskActivity[string] }) {
  const maxTotal = Math.max(...activity.map((d) => d.total));

  return (
    <div className="flex items-start gap-1.5">
      <div className="h-6 w-[7rem] rounded-sm">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={activity} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
            <YAxis domain={[0, maxTotal || 1]} hide />
            <Tooltip
              cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
              content={<TaskActivityTooltip />}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ zIndex: 1000 }}
              animationDuration={0}
            />
            {STATUS_BARS.map(({ status, fill }) => (
              <Bar
                key={status}
                dataKey={status}
                stackId="a"
                fill={fill}
                strokeWidth={0}
                isAnimationActive={false}
              />
            ))}
            <ReferenceLine y={0} stroke="#2C3034" strokeWidth={1} />
            {maxTotal > 0 && (
              <ReferenceLine y={maxTotal} stroke="#4D525B" strokeDasharray="4 4" strokeWidth={1} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <SimpleTooltip
        asChild
        button={
          <span className="-mt-1 text-xxs tabular-nums text-text-dimmed">
            {formatNumberCompact(maxTotal)}
          </span>
        }
        content="Peak runs in a single hour"
      />
    </div>
  );
}

function TaskActivityBlankState() {
  return (
    <div className="flex h-6 w-[7rem] items-end gap-px rounded-sm">
      {[...Array(24)].map((_, i) => (
        <div key={i} className="h-full flex-1 bg-[#212327]" />
      ))}
    </div>
  );
}

const TaskActivityTooltip = ({ active, payload }: TooltipProps<number, string>) => {
  if (active && payload && payload.length > 0) {
    const entry = payload[0].payload as { date: Date; total: number } & Partial<
      Record<TaskRunStatus, number>
    >;
    const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
    const formattedDate = formatDateTime(date, "UTC", [], false, true);
    const items = STATUS_BARS.filter(({ status }) => (entry[status] ?? 0) > 0).map(
      ({ status }) => ({ status, value: entry[status] ?? 0 })
    );

    return (
      <TooltipPortal active={active}>
        <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
          <Header3 className="border-b border-b-charcoal-650 pb-2">{formattedDate}</Header3>
          {items.length === 0 ? (
            <div className="mt-2 text-xs text-text-dimmed">No runs</div>
          ) : (
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 text-xs text-text-bright">
              {items.map((item) => (
                <Fragment key={item.status}>
                  <TaskRunStatusCombo status={item.status} />
                  <p className="tabular-nums">{item.value}</p>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      </TooltipPortal>
    );
  }
  return null;
};

function FailedToLoadStats() {
  return (
    <SimpleTooltip
      button={<ExclamationTriangleIcon className="size-4 text-warning" />}
      content="We were unable to load the task stats, please try again later."
    />
  );
}

const CHAT_AGENT_CODE = `import { chat } from "@trigger.dev/sdk/ai";
import { streamText, stepCountIs } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

export const myChat = chat.agent({
  id: "my-chat",
  run: async ({ messages, signal }) => {
    return streamText({
      ...chat.toStreamTextOptions(),
      model: anthropic("claude-sonnet-4-5"),
      messages,
      abortSignal: signal,
      stopWhen: stepCountIs(15),
    });
  },
});`;

const STANDARD_TASK_CODE = `import { task } from "@trigger.dev/sdk";

export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { message: string }) => {
    console.log(payload.message);
  },
});`;

const SCHEDULED_TASK_CODE = `import { schedules } from "@trigger.dev/sdk";

export const firstScheduledTask = schedules.task({
  id: "first-scheduled-task",
  run: async (payload) => {
    console.log(payload.timestamp);
    console.log(payload.lastTimestamp);
  },
});`;

function NewTaskPromptsPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-3 py-2">
        <Header2>Create a new task</Header2>
        <Button
          onClick={onClose}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Paragraph variant="small/bright" className="mb-6">
          Copy any example below into your project's{" "}
          <InlineCode variant="extra-small">trigger/</InlineCode> directory and customize it from
          there.
        </Paragraph>

        <PromptCard
          icon={<CubeSparkleIcon className="size-4.5 shrink-0 text-agents" />}
          title="Chat agent"
          description="An AI agent you can chat with from your app. Streams responses, calls tools and keeps context across messages."
          code={CHAT_AGENT_CODE}
        />
        <PromptCard
          icon={<TaskIcon className="size-4.5 shrink-0 text-tasks" />}
          title="Standard task"
          description="A durable background function you can trigger from your code. Runs as long as it needs without timing out."
          code={STANDARD_TASK_CODE}
        />
        <PromptCard
          icon={<ClockIcon className="size-4.5 shrink-0 text-schedules" />}
          title="Scheduled task"
          description="A task that runs automatically on a recurring cron schedule: daily, weekly, or any interval you define."
          code={SCHEDULED_TASK_CODE}
        />
      </div>
    </div>
  );
}

function PromptCard({
  icon,
  title,
  description,
  code,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  code: string;
}) {
  return (
    <div className="mb-5">
      <div className="mb-1 flex items-center gap-1.5">
        {icon}
        <Header2>{title}</Header2>
      </div>
      <Paragraph variant="small" className="mb-2 text-text-dimmed">
        {description}
      </Paragraph>
      <CodeBlock code={code} language="typescript" showCopyButton showLineNumbers={false} />
    </div>
  );
}

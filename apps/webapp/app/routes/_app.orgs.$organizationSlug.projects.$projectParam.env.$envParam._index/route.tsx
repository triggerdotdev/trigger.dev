import { BookOpenIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { json, type MetaFunction } from "@remix-run/node";
import { useFetcher, useRevalidator } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { TaskRunStatus } from "@trigger.dev/database";
import type { PanelHandle } from "@window-splitter/react";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClientOnly } from "remix-utils/client-only";
import { Bar, BarChart, ReferenceLine, Tooltip, type TooltipProps, YAxis } from "recharts";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { BeakerIcon } from "~/assets/icons/BeakerIcon";
import { ClockIcon } from "~/assets/icons/ClockIcon";
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { PlusIcon } from "~/assets/icons/PlusIcon";
import { QuestionMarkIcon } from "~/assets/icons/QuestionMarkIcon";
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
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
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
import {
  TaskTriggerSourceIcon,
  taskTriggerSourceDescription,
} from "~/components/runs/v3/TaskTriggerSource";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useFuzzyFilter } from "~/hooks/useFuzzyFilter";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
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
  v3TasksStreamingPath,
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
  { value: "AGENT", label: "Agent" },
  { value: "STANDARD", label: "Standard" },
  { value: "SCHEDULED", label: "Scheduled" },
];

const VALID_KINDS = new Set<UnifiedTaskKind>(KIND_OPTIONS.map((o) => o.value));

/** Parse `?types=…` URL values, dropping anything that isn't a known
 *  `UnifiedTaskKind`. Without this, a shareable URL with a typo would
 *  produce a filter that matches nothing and the user gets stuck on
 *  "No tasks match your filters" with no way to recover. */
function parseTypesParam(values: string[]): UnifiedTaskKind[] {
  return values.filter((v): v is UnifiedTaskKind => VALID_KINDS.has(v as UnifiedTaskKind));
}

const ALL_TASK_TYPES = "ALL";

type TaskTypeSegment = typeof ALL_TASK_TYPES | UnifiedTaskKind;

/** Segmented control options. "All" shows as a word; the task kinds show as
 *  icon-only segments. Every segment has a tooltip (label + shortcut).
 *  Order = shortcut keys 0–3. */
const TASK_TYPE_SEGMENTS: {
  value: TaskTypeSegment;
  tooltip: string;
  text?: string;
  source?: UnifiedTaskKind;
}[] = [
  { value: ALL_TASK_TYPES, tooltip: "All tasks", text: "All" },
  { value: "AGENT", tooltip: "Agent tasks", source: "AGENT" },
  { value: "STANDARD", tooltip: "Standard tasks", source: "STANDARD" },
  { value: "SCHEDULED", tooltip: "Scheduled tasks", source: "SCHEDULED" },
];

const PAGE_SIZE = 25;

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { items, hourlyActivity, runningStates, usefulLinksPreference } =
    useTypedLoaderData<typeof loader>();
  const { value, values } = useSearchParams();

  // Live-reload on WORKER_CREATED.
  const revalidator = useRevalidator();
  const streamedEvents = useEventSource(
    v3TasksStreamingPath(organization, project, environment),
    { event: "message" }
  );
  useEffect(() => {
    if (streamedEvents !== null) {
      revalidator.revalidate();
    }
    // Don't add `revalidator` to deps — infinite loop.
  }, [streamedEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  const [showUsefulLinks, setShowUsefulLinks] = useState(usefulLinksPreference ?? true);
  // Hide (don't unmount) the charts during the panel animation; 25 reflowing SVGs tank the resize.
  const [isPanelAnimating, setIsPanelAnimating] = useState(false);
  const animatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usefulLinksPanelRef = useRef<PanelHandle>(null);
  const fetcher = useFetcher();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const toggleUsefulLinks = useCallback((show: boolean) => {
    setShowUsefulLinks(show);
    setIsPanelAnimating(true);
    if (animatingTimerRef.current) clearTimeout(animatingTimerRef.current);
    // 300ms panel anim + 50ms buffer.
    animatingTimerRef.current = setTimeout(() => setIsPanelAnimating(false), 350);
    if (show) {
      usefulLinksPanelRef.current?.expand();
    } else {
      usefulLinksPanelRef.current?.collapse();
    }
    fetcherRef.current.submit({ showUsefulLinks: show.toString() }, { method: "post" });
  }, []);

  const selectedTypes = useMemo(() => {
    const raw = parseTypesParam(values("types"));
    // Single-select: one kind filters to it; none or legacy multi → all.
    return raw.length === 1 ? new Set(raw) : null; // null = all
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

  // Client-side pagination — presenter returns all tasks; we slice + clamp here.
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
        <PageTitle title="Tasks" accessory={<TasksHelpTooltip />} />
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
                  <div className="flex h-full flex-col overflow-hidden">
                    <div className="flex shrink-0 items-center justify-between gap-1.5 p-2">
                      <div className="flex flex-1 items-center gap-1.5">
                        <SearchInput placeholder="Search tasks…" resetParams={["page"]} />
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
                            New task…
                          </Button>
                        )}
                        <PaginationControls
                          currentPage={currentPage}
                          totalPages={totalPages}
                          showPageNumbers={false}
                        />
                      </div>
                    </div>
                    <Table containerClassName="min-h-0 flex-1">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>ID</TableHeaderCell>
                          <TableHeaderCell
                            tooltip={
                              <div className="max-w-sm">
                                <TaskTypeBreakdown />
                              </div>
                            }
                            disableTooltipHoverableContent
                          >
                            Type
                          </TableHeaderCell>
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
                              isPanelAnimating={isPanelAnimating}
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
  isPanelAnimating: boolean;
};

function TaskRow({
  item,
  runningStates,
  hourlyActivity,
  organization,
  project,
  environment,
  isPanelAnimating,
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
          <SimpleTooltip
            button={<TaskTriggerSourceIcon source={item.triggerSource} />}
            content={taskTriggerSourceDescription(item.triggerSource)}
            disableHoverableContent
          />
          <span>{item.slug}</span>
        </div>
      </TableCell>
      <TableCell to={rowPath}>
        <div className="flex items-center gap-2">
          <span>
            {item.kind === "AGENT" ? "Agent" : item.kind === "SCHEDULED" ? "Scheduled" : "Standard"}
          </span>
          {item.kind === "AGENT" && item.agentType && (
            <Badge variant="extra-small">{formatAgentType(item.agentType)}</Badge>
          )}
        </div>
      </TableCell>
      <TableCell to={rowPath}>
        <TaskFileName fileName={item.filePath} variant="extra-extra-small" />
      </TableCell>
      <TableCell to={rowPath}>
        {/* Render the deferred stats client-side. A streamed Suspense boundary still pending at
            hydration otherwise bails to client rendering and throws React #421. */}
        <ClientOnly fallback={<Spinner color="blue" className="size-3" />}>
          {() => (
            <Suspense fallback={<Spinner color="blue" className="size-3" />}>
              <TypedAwait resolve={runningStates} errorElement={<FailedToLoadStats />}>
                {(data) => <RunningCell state={data[item.slug]} />}
              </TypedAwait>
            </Suspense>
          )}
        </ClientOnly>
      </TableCell>
      <TableCell to={rowPath} actionClassName="py-1.5">
        <div style={{ width: ACTIVITY_CELL_WIDTH, height: ACTIVITY_CHART_HEIGHT }}>
          <div hidden={isPanelAnimating}>
            <ClientOnly fallback={<TaskActivityBlankState />}>
              {() => (
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
              )}
            </ClientOnly>
          </div>
        </div>
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
            variant="minimal/small"
            LeadingIcon={BeakerIcon}
            leadingIconClassName="-mx-2.5 text-tests"
            to={testPath}
          >
            <span className="text-text-bright">Test</span>
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
  const raw = parseTypesParam(values("types"));
  // Single-select: exactly one kind selects it, anything else falls back to All.
  const current: TaskTypeSegment = raw.length === 1 ? raw[0] : ALL_TASK_TYPES;

  const select = (value: string) => {
    // "All" drops the param; a kind filters to just that kind. Always reset page.
    replace({ types: value === ALL_TASK_TYPES ? undefined : [value], page: undefined });
  };

  return (
    <>
      {TASK_TYPE_SEGMENTS.map((option, index) => (
        <TaskTypeShortcut
          key={option.value}
          shortcut={String(index)}
          onSelect={() => select(option.value)}
        />
      ))}
      <SegmentedControl
        name="task-type"
        value={current}
        variant="secondary/small"
        onChange={select}
        options={TASK_TYPE_SEGMENTS.map((option, index) => ({
          value: option.value,
          label: <TaskTypeSegmentLabel option={option} shortcut={String(index)} />,
        }))}
      />
    </>
  );
}

// Registers a number-key shortcut that selects one segment.
function TaskTypeShortcut({ shortcut, onSelect }: { shortcut: string; onSelect: () => void }) {
  useShortcutKeys({
    shortcut: { key: shortcut },
    action: (event) => {
      event.preventDefault();
      onSelect();
    },
  });
  return null;
}

function TaskTypeSegmentLabel({
  option,
  shortcut,
}: {
  option: (typeof TASK_TYPE_SEGMENTS)[number];
  shortcut: string;
}) {
  return (
    <SimpleTooltip
      asChild
      button={
        option.source ? (
          // -mx-0.5 tightens the icon segment toward a square button.
          <span className="-mx-0.5 flex items-center justify-center">
            <TaskTriggerSourceIcon source={option.source} />
            <span className="sr-only">{option.tooltip}</span>
          </span>
        ) : (
          <span className="flex items-center justify-center">{option.text}</span>
        )
      }
      content={
        <div className="flex items-center gap-1">
          <span className="text-text-bright">{option.tooltip}</span>
          <ShortcutKey shortcut={{ key: shortcut }} variant="small" />
        </div>
      }
      className="px-2 py-1.5 text-xs"
      sideOffset={6}
      disableHoverableContent
    />
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

// Fixed px dims skip ResponsiveContainer's ResizeObserver — otherwise every panel resize re-renders all 25 charts.
const ACTIVITY_CHART_WIDTH = 112;
const ACTIVITY_CHART_HEIGHT = 24;
// chart (112) + gap-1.5 (6) + count min-w (28). Reserved so the column stays put while the chart unmounts.
const ACTIVITY_CELL_WIDTH = 146;
const ACTIVITY_CHART_COUNT_CLASS =
  "-mt-1 inline-block min-w-[1.75rem] text-xxs tabular-nums text-text-dimmed";

function TaskActivityGraph({ activity }: { activity: HourlyTaskActivity[string] }) {
  const maxTotal = Math.max(...activity.map((d) => d.total));

  return (
    <div className="flex items-start gap-1.5">
      <div
        className="rounded-sm"
        style={{ width: ACTIVITY_CHART_WIDTH, height: ACTIVITY_CHART_HEIGHT }}
      >
        <BarChart
          data={activity}
          width={ACTIVITY_CHART_WIDTH}
          height={ACTIVITY_CHART_HEIGHT}
          margin={{ top: 0, right: 0, left: 0, bottom: 0 }}
        >
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
      </div>
      <SimpleTooltip
        asChild
        button={<span className={ACTIVITY_CHART_COUNT_CLASS}>{formatNumberCompact(maxTotal)}</span>}
        content="Peak runs in a single hour"
      />
    </div>
  );
}

// SVG line matches recharts' y=0 ReferenceLine anti-aliasing; a CSS border looks too crisp.
function TaskActivityBlankState() {
  return (
    <div className="flex items-start gap-1.5">
      <svg width={ACTIVITY_CHART_WIDTH} height={ACTIVITY_CHART_HEIGHT} className="rounded-sm">
        <line
          x1={0}
          y1={ACTIVITY_CHART_HEIGHT}
          x2={ACTIVITY_CHART_WIDTH}
          y2={ACTIVITY_CHART_HEIGHT}
          stroke="#333539"
          strokeWidth={1}
        />
      </svg>
      <span className={ACTIVITY_CHART_COUNT_CLASS}>0</span>
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

function TaskTypeBreakdown() {
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <div className="flex items-center gap-1.5">
          <CubeSparkleIcon className="size-4.5 shrink-0 text-agents" />
          <Paragraph variant="small/bright">Agent task</Paragraph>
        </div>
        <Paragraph variant="small" className="mt-1">
          A long-lived AI session. Streams LLM responses to your app and keeps context across
          messages, page refreshes, and deploys.
        </Paragraph>
      </div>
      <div>
        <div className="flex items-center gap-1.5">
          <TaskIcon className="size-4.5 shrink-0 text-tasks" />
          <Paragraph variant="small/bright">Standard task</Paragraph>
        </div>
        <Paragraph variant="small" className="mt-1">
          A background function you trigger from your code with a payload. Good for AI workflows,
          image generation, audio transcription, document processing, and any other long-running
          work where reliability matters.
        </Paragraph>
      </div>
      <div>
        <div className="flex items-center gap-1.5">
          <ClockIcon className="size-4.5 shrink-0 text-schedules" />
          <Paragraph variant="small/bright">Scheduled task</Paragraph>
        </div>
        <Paragraph variant="small" className="mt-1">
          Runs automatically on a recurring cron schedule. Use daily, weekly, or any custom interval
          you need.
        </Paragraph>
      </div>
    </div>
  );
}

function TasksHelpTooltip() {
  return (
    <SimpleTooltip
      button={
        <QuestionMarkIcon className="size-4 text-text-dimmed transition hover:text-text-bright" />
      }
      side="bottom"
      className="max-w-sm p-3"
      disableHoverableContent
      content={
        <div className="flex flex-col gap-3">
          <div>
            <Paragraph variant="small/bright">What is a task?</Paragraph>
            <Paragraph variant="small" className="mt-1">
              A task is a durable function that runs in the background. It can run for as long as it
              needs without timing out, automatically retries on failure, and survives crashes and
              deploys.
            </Paragraph>
          </div>
          <div className="border-t border-grid-dimmed pt-3">
            <TaskTypeBreakdown />
          </div>
        </div>
      }
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

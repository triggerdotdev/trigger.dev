import { BookOpenIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/node";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { TaskRunStatus } from "@trigger.dev/database";
import { Fragment, Suspense, useMemo } from "react";
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
import { CubeSparkleIcon } from "~/assets/icons/CubeSparkleIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { HasNoTasksDeployed, HasNoTasksDev } from "~/components/BlankStatePanels";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { PopoverMenuItem } from "~/components/primitives/Popover";
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
  unifiedTaskListPresenter,
  type HourlyTaskActivity,
  type UnifiedRunningState,
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

    return typeddefer({ items, hourlyActivity, runningStates });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

const KIND_OPTIONS: { value: UnifiedTaskKind; label: string }[] = [
  { value: "AGENT", label: "Agent tasks" },
  { value: "STANDARD", label: "Standard tasks" },
  { value: "SCHEDULED", label: "Scheduled tasks" },
];

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { items, hourlyActivity, runningStates } = useTypedLoaderData<typeof loader>();
  const { value, values } = useSearchParams();

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
        <div className={cn("grid h-full grid-rows-1")}>
          {hasItems ? (
            <div className="flex min-w-0 max-w-full flex-col">
              <div className="max-h-full overflow-hidden">
                <div className="flex items-center gap-1.5 p-2">
                  <SearchInput placeholder="Search tasks…" autoFocus />
                  <TaskTypeFilter />
                </div>
                <Table containerClassName="max-h-full pb-[2.5rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Task ID</TableHeaderCell>
                      <TableHeaderCell>Task type</TableHeaderCell>
                      <TableHeaderCell>File</TableHeaderCell>
                      <TableHeaderCell>Running</TableHeaderCell>
                      <TableHeaderCell>Activity (24h)</TableHeaderCell>
                      <TableHeaderCell hiddenLabel>Go to page</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleItems.length > 0 ? (
                      visibleItems.map((item) => {
                        const rowPath =
                          item.kind === "AGENT"
                            ? v3AgentTaskPath(organization, project, environment, item.slug)
                            : item.kind === "SCHEDULED"
                            ? v3ScheduledTaskPath(organization, project, environment, item.slug)
                            : v3StandardTaskPath(organization, project, environment, item.slug);

                        const testPath =
                          item.kind === "AGENT"
                            ? v3PlaygroundAgentPath(organization, project, environment, item.slug)
                            : v3TestTaskPath(organization, project, environment, {
                                taskIdentifier: item.slug,
                              });

                        const runsPath = v3RunsPath(organization, project, environment, {
                          tasks: [item.slug],
                        });

                        return (
                          <TableRow key={item.slug} className="group">
                            <TableCell to={rowPath} isTabbableCell>
                              <div className="flex items-center gap-2">
                                <SimpleTooltip
                                  button={
                                    item.kind === "AGENT" ? (
                                      <CubeSparkleIcon className="size-4.5 text-agents" />
                                    ) : (
                                      <TaskTriggerSourceIcon source={item.triggerSource} />
                                    )
                                  }
                                  content={
                                    item.kind === "AGENT"
                                      ? "Agent task"
                                      : item.kind === "SCHEDULED"
                                      ? "Scheduled task"
                                      : "Standard task"
                                  }
                                  disableHoverableContent
                                />
                                <span>{item.slug}</span>
                              </div>
                            </TableCell>
                            <TableCell to={rowPath}>
                              <div className="flex items-center gap-2">
                                <span>
                                  {item.kind === "AGENT"
                                    ? "Agent"
                                    : item.kind === "SCHEDULED"
                                    ? "Scheduled"
                                    : "Standard"}
                                </span>
                                {item.kind === "AGENT" && item.agentType && (
                                  <Badge variant="extra-small">
                                    {formatAgentType(item.agentType)}
                                  </Badge>
                                )}
                              </div>
                            </TableCell>
                            <TableCell to={rowPath}>
                              <TaskFileName fileName={item.filePath} variant="extra-extra-small" />
                            </TableCell>
                            <TableCell to={rowPath}>
                              <Suspense fallback={<Spinner color="muted" />}>
                                <TypedAwait
                                  resolve={runningStates}
                                  errorElement={<FailedToLoadStats />}
                                >
                                  {(data) => <RunningCell state={data[item.slug]} />}
                                </TypedAwait>
                              </Suspense>
                            </TableCell>
                            <TableCell to={rowPath} actionClassName="py-1.5">
                              <Suspense fallback={<TaskActivityBlankState />}>
                                <TypedAwait
                                  resolve={hourlyActivity}
                                  errorElement={<FailedToLoadStats />}
                                >
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
      </PageBody>
    </PageContainer>
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
    if (next.length === 0 || next.length === KIND_OPTIONS.length) {
      replace({ types: undefined });
    } else {
      replace({ types: next });
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

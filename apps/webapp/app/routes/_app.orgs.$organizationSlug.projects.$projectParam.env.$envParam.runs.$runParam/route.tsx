import {
  ArrowUturnLeftIcon,
  BoltSlashIcon,
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  InformationCircleIcon,
  LockOpenIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  StopCircleIcon,
} from "@heroicons/react/20/solid";
import { useLoaderData, useParams, useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs, type SerializeFrom, json } from "@remix-run/server-runtime";
import { type Virtualizer } from "@tanstack/react-virtual";
import {
  formatDurationMilliseconds,
  millisecondsToNanoseconds,
  nanosecondsToMilliseconds,
  tryCatch,
} from "@trigger.dev/core/v3";
import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { redirect } from "remix-typedjson";
import { ShowParentIcon, ShowParentIconSelected } from "~/assets/icons/ShowParentIcon";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { DevDisconnectedBanner, useCrossEngineIsConnected } from "~/components/DevPresence";
import { WarmStartIconWithTooltip } from "~/components/WarmStarts";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { PageBody } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { DateTimeShort } from "~/components/primitives/DateTime";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverArrowTrigger, PopoverContent } from "~/components/primitives/Popover";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { ShortcutKey, variants } from "~/components/primitives/ShortcutKey";
import { Slider } from "~/components/primitives/Slider";
import { Switch } from "~/components/primitives/Switch";
import * as Timeline from "~/components/primitives/Timeline";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import {
  TreeView,
  type UseTreeStateOutput,
  useTree,
} from "~/components/primitives/TreeView/TreeView";
import { type NodesState } from "~/components/primitives/TreeView/reducer";
import { CancelRunDialog } from "~/components/runs/v3/CancelRunDialog";
import { ReplayRunDialog } from "~/components/runs/v3/ReplayRunDialog";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import {
  SpanTitle,
  eventBackgroundClassName,
  eventBorderClassName,
} from "~/components/runs/v3/SpanTitle";
import { TaskRunStatusIcon, runStatusClassNameColor } from "~/components/runs/v3/TaskRunStatus";
import { env } from "~/env.server";
import { useDebounce } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useEventSource } from "~/hooks/useEventSource";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useReplaceSearchParams } from "~/hooks/useReplaceSearchParams";
import { type Shortcut, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useHasAdminAccess } from "~/hooks/useUser";
import { RunEnvironmentMismatchError, RunPresenter } from "~/presenters/v3/RunPresenter.server";
import { getImpersonationId } from "~/services/impersonation.server";
import { getResizableSnapshot } from "~/services/resizablePanel.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { lerp } from "~/utils/lerp";
import {
  docsPath,
  v3BillingPath,
  v3RunParamsSchema,
  v3RunPath,
  v3RunRedirectPath,
  v3RunSpanPath,
  v3RunStreamingPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";
import { SpanView } from "../resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.spans.$spanParam/route";

const resizableSettings = {
  parent: {
    autosaveId: "panel-run-parent",
    handleId: "parent-handle",
    main: {
      id: "run",
      min: "100px" as const,
    },
    inspector: {
      id: "inspector",
      default: "430px" as const,
      min: "50px" as const,
    },
  },
  tree: {
    autosaveId: "panel-run-tree",
    handleId: "tree-handle",
    tree: {
      id: "tree",
      default: "50%" as const,
      min: "50px" as const,
    },
    timeline: {
      id: "timeline",
      default: "50%" as const,
      min: "50px" as const,
    },
  },
};

type TraceEvent = NonNullable<SerializeFrom<typeof loader>["trace"]>["events"][0];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const impersonationId = await getImpersonationId(request);
  const { projectParam, organizationSlug, envParam, runParam } = v3RunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const [error, result] = await tryCatch(
    presenter.call({
      userId,
      organizationSlug,
      showDeletedLogs: !!impersonationId,
      projectSlug: projectParam,
      runFriendlyId: runParam,
      environmentSlug: envParam,
    })
  );

  if (error) {
    if (error instanceof RunEnvironmentMismatchError) {
      throw redirect(
        v3RunRedirectPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { friendlyId: runParam }
        )
      );
    }

    throw error;
  }

  //resizable settings
  const parent = await getResizableSnapshot(request, resizableSettings.parent.autosaveId);
  const tree = await getResizableSnapshot(request, resizableSettings.tree.autosaveId);

  return json({
    run: result.run,
    trace: result.trace,
    maximumLiveReloadingSetting: env.MAXIMUM_LIVE_RELOADING_EVENTS,
    resizable: {
      parent,
      tree,
    },
  });
};

type LoaderData = SerializeFrom<typeof loader>;

export default function Page() {
  const { run, trace, resizable, maximumLiveReloadingSetting } = useLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const isConnected = useCrossEngineIsConnected({
    logCount: trace?.events.length ?? 0,
    isCompleted: run.completedAt !== null,
  });

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{
            to: v3RunsPath(organization, project, environment),
            text: "Runs",
          }}
          title={`Run #${run.number}`}
        />
        {environment.type === "DEVELOPMENT" && <DevDisconnectedBanner isConnected={isConnected} />}
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>ID</Property.Label>
                <Property.Value>{run.id}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Trace ID</Property.Label>
                <Property.Value>{run.traceId}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Env ID</Property.Label>
                <Property.Value>{run.environment.id}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Org ID</Property.Label>
                <Property.Value>{run.environment.organizationId}</Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>
          <LinkButton variant={"docs/small"} LeadingIcon={BookOpenIcon} to={docsPath("/runs")}>
            Run docs
          </LinkButton>
          <Dialog key={`replay-${run.friendlyId}`}>
            <DialogTrigger asChild>
              <Button
                variant="tertiary/small"
                LeadingIcon={ArrowUturnLeftIcon}
                shortcut={{ key: "R" }}
              >
                Replay run
              </Button>
            </DialogTrigger>
            <ReplayRunDialog
              runFriendlyId={run.friendlyId}
              failedRedirect={v3RunSpanPath(
                organization,
                project,
                environment,
                { friendlyId: run.friendlyId },
                { spanId: run.spanId }
              )}
            />
          </Dialog>
          {run.isFinished ? null : (
            <Dialog key={`cancel-${run.friendlyId}`}>
              <DialogTrigger asChild>
                <Button variant="danger/small" LeadingIcon={StopCircleIcon} shortcut={{ key: "C" }}>
                  Cancel run…
                </Button>
              </DialogTrigger>
              <CancelRunDialog
                runFriendlyId={run.friendlyId}
                redirectPath={v3RunSpanPath(
                  organization,
                  project,
                  environment,
                  { friendlyId: run.friendlyId },
                  { spanId: run.spanId }
                )}
              />
            </Dialog>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {trace ? (
          <TraceView
            run={run}
            trace={trace}
            maximumLiveReloadingSetting={maximumLiveReloadingSetting}
            resizable={resizable}
          />
        ) : (
          <NoLogsView
            run={run}
            trace={trace}
            maximumLiveReloadingSetting={maximumLiveReloadingSetting}
            resizable={resizable}
          />
        )}
      </PageBody>
    </>
  );
}

function TraceView({ run, trace, maximumLiveReloadingSetting, resizable }: LoaderData) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { searchParams, replaceSearchParam } = useReplaceSearchParams();
  const selectedSpanId = searchParams.get("span") ?? undefined;

  if (!trace) {
    return <></>;
  }

  const { events, parentRunFriendlyId, duration, rootSpanStatus, rootStartedAt, queuedDuration } =
    trace;
  const shouldLiveReload = events.length <= maximumLiveReloadingSetting;

  const changeToSpan = useDebounce((selectedSpan: string) => {
    replaceSearchParam("span", selectedSpan, { replace: true });
  }, 250);

  const revalidator = useRevalidator();
  const streamedEvents = useEventSource(
    v3RunStreamingPath(organization, project, environment, run),
    {
      event: "message",
      disabled: !shouldLiveReload,
    }
  );
  useEffect(() => {
    if (streamedEvents !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [streamedEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn("grid h-full max-h-full grid-cols-1 overflow-hidden")}>
      <ResizablePanelGroup
        autosaveId={resizableSettings.parent.autosaveId}
        // snapshot={resizable.parent}
        className="h-full max-h-full"
      >
        <ResizablePanel
          id={resizableSettings.parent.main.id}
          min={resizableSettings.parent.main.min}
        >
          <TasksTreeView
            selectedId={selectedSpanId}
            key={events[0]?.id ?? "-"}
            events={events}
            parentRunFriendlyId={parentRunFriendlyId}
            onSelectedIdChanged={(selectedSpan) => {
              //instantly close the panel if no span is selected
              if (!selectedSpan) {
                replaceSearchParam("span");
                return;
              }

              changeToSpan(selectedSpan);
            }}
            totalDuration={duration}
            rootSpanStatus={rootSpanStatus}
            rootStartedAt={rootStartedAt ? new Date(rootStartedAt) : undefined}
            queuedDuration={queuedDuration}
            environmentType={run.environment.type}
            shouldLiveReload={shouldLiveReload}
            maximumLiveReloadingSetting={maximumLiveReloadingSetting}
            rootRun={run.rootTaskRun}
            isCompleted={run.completedAt !== null}
          />
        </ResizablePanel>
        <ResizableHandle id={resizableSettings.parent.handleId} />
        {selectedSpanId && (
          <ResizablePanel
            id={resizableSettings.parent.inspector.id}
            default={resizableSettings.parent.inspector.default}
            min={resizableSettings.parent.inspector.min}
            isStaticAtRest
          >
            {" "}
            <SpanView
              runParam={run.friendlyId}
              spanId={selectedSpanId}
              closePanel={() => replaceSearchParam("span")}
            />
          </ResizablePanel>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

function NoLogsView({ run, resizable }: LoaderData) {
  const plan = useCurrentPlan();
  const organization = useOrganization();

  const logRetention = plan?.v3Subscription?.plan?.limits.logRetentionDays.number ?? 30;

  const completedAt = run.completedAt ? new Date(run.completedAt) : undefined;
  const now = new Date();

  const daysSinceCompleted = completedAt
    ? Math.floor((now.getTime() - completedAt.getTime()) / (1000 * 60 * 60 * 24))
    : undefined;

  const isWithinLogRetention =
    daysSinceCompleted !== undefined && daysSinceCompleted <= logRetention;

  return (
    <div className={cn("grid h-full max-h-full grid-cols-1 overflow-hidden")}>
      <ResizablePanelGroup
        autosaveId={resizableSettings.parent.autosaveId}
        // snapshot={resizable.parent}
        className="h-full max-h-full"
      >
        <ResizablePanel
          id={resizableSettings.parent.main.id}
          min={resizableSettings.parent.main.min}
        >
          <div className="grid h-full place-items-center">
            {daysSinceCompleted === undefined ? (
              <InfoPanel variant="info" icon={InformationCircleIcon} title="We delete old logs">
                <Paragraph variant="small">
                  We tidy up older logs to keep things running smoothly.
                </Paragraph>
              </InfoPanel>
            ) : isWithinLogRetention ? (
              <InfoPanel
                variant="info"
                icon={InformationCircleIcon}
                title="These logs have been deleted"
              >
                <Paragraph variant="small">
                  Your log retention is {logRetention} days but these logs had already been deleted.
                  From now on only logs from runs that completed {logRetention} days ago will be
                  deleted.
                </Paragraph>
              </InfoPanel>
            ) : daysSinceCompleted <= 30 ? (
              <InfoPanel
                variant="upgrade"
                icon={LockOpenIcon}
                iconClassName="text-indigo-500"
                title="Unlock longer log retention"
                accessory={
                  <LinkButton to={v3BillingPath(organization)} variant="secondary/small">
                    Upgrade
                  </LinkButton>
                }
              >
                <Paragraph variant="small">
                  The logs for this run have been deleted because the run completed{" "}
                  {daysSinceCompleted} days ago.
                </Paragraph>
                <Paragraph variant="small">Upgrade your plan to keep logs for longer.</Paragraph>
              </InfoPanel>
            ) : (
              <InfoPanel
                variant="info"
                icon={InformationCircleIcon}
                title="These logs are more than 30 days old"
              >
                <Paragraph variant="small">
                  We tidy up older logs to keep things running smoothly.
                </Paragraph>
              </InfoPanel>
            )}
          </div>
        </ResizablePanel>
        <ResizableHandle id={resizableSettings.parent.handleId} />
        <ResizablePanel
          id={resizableSettings.parent.inspector.id}
          default={resizableSettings.parent.inspector.default}
          min={resizableSettings.parent.inspector.min}
          isStaticAtRest
        >
          <SpanView runParam={run.friendlyId} spanId={run.spanId} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

type TasksTreeViewProps = {
  events: TraceEvent[];
  selectedId?: string;
  parentRunFriendlyId?: string;
  onSelectedIdChanged: (selectedId: string | undefined) => void;
  totalDuration: number;
  rootSpanStatus: "executing" | "completed" | "failed";
  rootStartedAt: Date | undefined;
  queuedDuration: number | undefined;
  environmentType: RuntimeEnvironmentType;
  shouldLiveReload: boolean;
  maximumLiveReloadingSetting: number;
  rootRun: {
    friendlyId: string;
    taskIdentifier: string;
    spanId: string;
  } | null;
  isCompleted: boolean;
};

function TasksTreeView({
  events,
  selectedId,
  parentRunFriendlyId,
  onSelectedIdChanged,
  totalDuration,
  rootSpanStatus,
  rootStartedAt,
  queuedDuration,
  environmentType,
  shouldLiveReload,
  maximumLiveReloadingSetting,
  rootRun,
  isCompleted,
}: TasksTreeViewProps) {
  const isAdmin = useHasAdminAccess();
  const [filterText, setFilterText] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showDurations, setShowDurations] = useState(true);
  const [showQueueTime, setShowQueueTime] = useState(false);
  const [scale, setScale] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

  const displayEvents = showDebug ? events : events.filter((event) => !event.data.isDebug);
  const queuedTime = showQueueTime ? undefined : queuedDuration;

  const {
    nodes,
    getTreeProps,
    getNodeProps,
    toggleNodeSelection,
    toggleExpandNode,
    expandAllBelowDepth,
    toggleExpandLevel,
    collapseAllBelowDepth,
    selectNode,
    scrollToNode,
    virtualizer,
  } = useTree({
    tree: displayEvents,
    selectedId,
    // collapsedIds,
    onSelectedIdChanged,
    estimatedRowHeight: () => 32,
    parentRef,
    filter: {
      value: { text: filterText, errorsOnly },
      fn: (value, node) => {
        const nodePassesErrorTest = (value.errorsOnly && node.data.isError) || !value.errorsOnly;
        if (!nodePassesErrorTest) return false;

        if (value.text === "") return true;
        if (node.data.message.toLowerCase().includes(value.text.toLowerCase())) {
          return true;
        }
        return false;
      },
    },
  });

  return (
    <div className="grid h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-2">
        <SearchField onChange={setFilterText} />
        {isAdmin && (
          <Switch
            variant="small"
            label="Debug"
            shortcut={{ modifiers: ["shift"], key: "D" }}
            checked={showDebug}
            onCheckedChange={(e) => setShowDebug(e.valueOf())}
          />
        )}
        <Switch
          variant="small"
          label="Queue time"
          checked={showQueueTime}
          onCheckedChange={(e) => setShowQueueTime(e.valueOf())}
        />
        <Switch
          variant="small"
          label="Errors only"
          checked={errorsOnly}
          onCheckedChange={(e) => setErrorsOnly(e.valueOf())}
        />
      </div>
      <ResizablePanelGroup autosaveId={resizableSettings.tree.autosaveId}>
        {/* Tree list */}
        <ResizablePanel
          id={resizableSettings.tree.tree.id}
          default={resizableSettings.tree.tree.default}
          min={resizableSettings.tree.tree.min}
          className="pl-3"
        >
          <div className="grid h-full grid-rows-[2rem_1fr] overflow-hidden">
            <div className="flex items-center pr-2">
              {rootRun ? (
                <ShowParentLink
                  runFriendlyId={rootRun.friendlyId}
                  isRoot={true}
                  spanId={rootRun.spanId}
                />
              ) : parentRunFriendlyId ? (
                <ShowParentLink runFriendlyId={parentRunFriendlyId} isRoot={false} />
              ) : (
                <Paragraph variant="small" className="flex-1 text-charcoal-500">
                  This is the root task
                </Paragraph>
              )}
              <LiveReloadingStatus
                rootSpanCompleted={rootSpanStatus !== "executing"}
                isLiveReloading={shouldLiveReload}
                settingValue={maximumLiveReloadingSetting}
              />
            </div>
            <TreeView
              parentRef={parentRef}
              scrollRef={treeScrollRef}
              virtualizer={virtualizer}
              autoFocus
              tree={events}
              nodes={nodes}
              getNodeProps={getNodeProps}
              getTreeProps={getTreeProps}
              renderNode={({ node, state, index }) => (
                <>
                  <div
                    className={cn(
                      "flex h-8 cursor-pointer items-center overflow-hidden rounded-l-sm pr-2",
                      state.selected
                        ? "bg-grid-dimmed hover:bg-grid-bright"
                        : "bg-transparent hover:bg-grid-dimmed"
                    )}
                    onClick={() => {
                      selectNode(node.id);
                    }}
                  >
                    <div className="flex h-8 items-center">
                      {Array.from({ length: node.level }).map((_, index) => (
                        <TaskLine
                          key={index}
                          isError={node.data.isError}
                          isSelected={state.selected}
                        />
                      ))}
                      <div
                        className={cn(
                          "flex h-8 w-4 items-center",
                          node.hasChildren && "hover:bg-charcoal-600"
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (e.altKey) {
                            if (state.expanded) {
                              collapseAllBelowDepth(node.level);
                            } else {
                              expandAllBelowDepth(node.level);
                            }
                          } else {
                            toggleExpandNode(node.id);
                          }
                          scrollToNode(node.id);
                        }}
                      >
                        {node.hasChildren ? (
                          state.expanded ? (
                            <ChevronDownIcon className="h-4 w-4 text-charcoal-400" />
                          ) : (
                            <ChevronRightIcon className="h-4 w-4 text-charcoal-400" />
                          )
                        ) : (
                          <div className="h-8 w-4" />
                        )}
                      </div>
                    </div>

                    <div className="flex w-full items-center justify-between gap-2 pl-1">
                      <div className="flex items-center gap-1.5 overflow-x-hidden">
                        <RunIcon
                          name={node.data.style?.icon}
                          spanName={node.data.message}
                          className="size-5 min-h-5 min-w-5"
                        />
                        <NodeText node={node} />
                        {node.data.isRoot && !rootRun && <Badge variant="extra-small">Root</Badge>}
                      </div>
                      <div className="flex items-center gap-1">
                        <NodeStatusIcon node={node} />
                      </div>
                    </div>
                  </div>
                </>
              )}
              onScroll={(scrollTop) => {
                //sync the scroll to the tree
                if (timelineScrollRef.current) {
                  timelineScrollRef.current.scrollTop = scrollTop;
                }
              }}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle id={resizableSettings.tree.handleId} />
        {/* Timeline */}
        <ResizablePanel
          id={resizableSettings.tree.timeline.id}
          default={resizableSettings.tree.timeline.default}
          min={resizableSettings.tree.timeline.min}
        >
          <TimelineView
            totalDuration={totalDuration}
            scale={scale}
            events={events}
            rootSpanStatus={rootSpanStatus}
            rootStartedAt={rootStartedAt}
            queuedDuration={queuedTime}
            parentRef={parentRef}
            timelineScrollRef={timelineScrollRef}
            nodes={nodes}
            getNodeProps={getNodeProps}
            getTreeProps={getTreeProps}
            showDurations={showDurations}
            treeScrollRef={treeScrollRef}
            virtualizer={virtualizer}
            toggleNodeSelection={toggleNodeSelection}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
      <div className="flex items-center justify-between gap-2 border-t border-grid-dimmed px-4">
        <div className="grow @container">
          <div className="hidden items-center gap-4 @[42rem]:flex">
            <KeyboardShortcuts
              expandAllBelowDepth={expandAllBelowDepth}
              collapseAllBelowDepth={collapseAllBelowDepth}
              toggleExpandLevel={toggleExpandLevel}
              setShowDurations={setShowDurations}
            />
          </div>
          <div className="@[42rem]:hidden">
            <Popover>
              <PopoverArrowTrigger>Shortcuts</PopoverArrowTrigger>
              <PopoverContent
                className="min-w-[20rem] overflow-y-auto p-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
                align="start"
              >
                <Header3 spacing>Keyboard shortcuts</Header3>
                <div className="flex flex-col gap-2">
                  <KeyboardShortcuts
                    expandAllBelowDepth={expandAllBelowDepth}
                    collapseAllBelowDepth={collapseAllBelowDepth}
                    toggleExpandLevel={toggleExpandLevel}
                    setShowDurations={setShowDurations}
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Slider
            variant={"tertiary"}
            className="w-20"
            LeadingIcon={MagnifyingGlassMinusIcon}
            TrailingIcon={MagnifyingGlassPlusIcon}
            value={[scale]}
            onValueChange={(value) => setScale(value[0])}
            min={0}
            max={1}
            step={0.05}
          />
        </div>
      </div>
    </div>
  );
}

type TimelineViewProps = Pick<
  TasksTreeViewProps,
  "totalDuration" | "rootSpanStatus" | "events" | "rootStartedAt" | "queuedDuration"
> & {
  scale: number;
  parentRef: React.RefObject<HTMLDivElement>;
  timelineScrollRef: React.RefObject<HTMLDivElement>;
  virtualizer: Virtualizer<HTMLElement, Element>;
  nodes: NodesState;
  getNodeProps: UseTreeStateOutput["getNodeProps"];
  getTreeProps: UseTreeStateOutput["getTreeProps"];
  toggleNodeSelection: UseTreeStateOutput["toggleNodeSelection"];
  showDurations: boolean;
  treeScrollRef: React.RefObject<HTMLDivElement>;
};

const tickCount = 5;

function TimelineView({
  totalDuration,
  scale,
  rootSpanStatus,
  rootStartedAt,
  parentRef,
  timelineScrollRef,
  virtualizer,
  events,
  nodes,
  getNodeProps,
  getTreeProps,
  toggleNodeSelection,
  showDurations,
  treeScrollRef,
  queuedDuration,
}: TimelineViewProps) {
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const initialTimelineDimensions = useInitialDimensions(timelineContainerRef);
  const minTimelineWidth = initialTimelineDimensions?.width ?? 300;
  const maxTimelineWidth = minTimelineWidth * 10;

  //we want to live-update the duration if the root span is still executing
  const [duration, setDuration] = useState(queueAdjustedNs(totalDuration, queuedDuration));
  useEffect(() => {
    if (rootSpanStatus !== "executing" || !rootStartedAt) {
      setDuration(queueAdjustedNs(totalDuration, queuedDuration));
      return;
    }

    const interval = setInterval(() => {
      setDuration(
        queueAdjustedNs(
          millisecondsToNanoseconds(Date.now() - rootStartedAt.getTime()),
          queuedDuration
        )
      );
    }, 500);

    return () => clearInterval(interval);
  }, [totalDuration, rootSpanStatus, queuedDuration, rootStartedAt]);

  return (
    <div
      className="h-full overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
      ref={timelineContainerRef}
    >
      <Timeline.Root
        durationMs={nanosecondsToMilliseconds(duration * 1.05)}
        scale={scale}
        className="h-full overflow-hidden"
        minWidth={minTimelineWidth}
        maxWidth={maxTimelineWidth}
      >
        {/* Follows the cursor */}
        <CurrentTimeIndicator
          totalDuration={duration}
          rootStartedAt={rootStartedAt}
          queuedDurationNs={queuedDuration}
        />

        <Timeline.Row className="grid h-full grid-rows-[2rem_1fr]">
          {/* The duration labels */}
          <Timeline.Row>
            <Timeline.Row className="h-6">
              <Timeline.EquallyDistribute count={tickCount}>
                {(ms: number, index: number) => {
                  if (index === tickCount - 1) return null;
                  return (
                    <Timeline.Point
                      ms={ms}
                      className={"relative bottom-[2px] text-xxs text-text-dimmed"}
                    >
                      {(ms) => (
                        <div
                          className={cn(
                            "whitespace-nowrap",
                            index === 0
                              ? "ml-1"
                              : index === tickCount - 1
                              ? "-ml-1 -translate-x-full"
                              : "-translate-x-1/2"
                          )}
                        >
                          {formatDurationMilliseconds(ms, {
                            style: "short",
                            maxDecimalPoints: ms < 1000 ? 0 : 1,
                          })}
                        </div>
                      )}
                    </Timeline.Point>
                  );
                }}
              </Timeline.EquallyDistribute>
              {rootSpanStatus !== "executing" && (
                <Timeline.Point
                  ms={nanosecondsToMilliseconds(duration)}
                  className={cn(
                    "relative bottom-[2px] text-xxs",
                    rootSpanStatus === "completed" ? "text-success" : "text-error"
                  )}
                >
                  {(ms) => (
                    <div className={cn("-translate-x-1/2 whitespace-nowrap")}>
                      {formatDurationMilliseconds(ms, {
                        style: "short",
                        maxDecimalPoints: ms < 1000 ? 0 : 1,
                      })}
                    </div>
                  )}
                </Timeline.Point>
              )}
            </Timeline.Row>
            <Timeline.Row className="h-2">
              <Timeline.EquallyDistribute count={tickCount}>
                {(ms: number, index: number) => {
                  if (index === 0 || index === tickCount - 1) return null;
                  return (
                    <Timeline.Point ms={ms} className={"h-full border-r border-grid-dimmed"} />
                  );
                }}
              </Timeline.EquallyDistribute>
              <Timeline.Point
                ms={nanosecondsToMilliseconds(duration)}
                className={cn(
                  "h-full border-r",
                  rootSpanStatus === "completed" ? "border-success/30" : "border-error/30"
                )}
              />
            </Timeline.Row>
          </Timeline.Row>
          {/* Main timeline body */}
          <Timeline.Row className="overflow-hidden">
            {/* The vertical tick lines */}
            <Timeline.EquallyDistribute count={tickCount}>
              {(ms: number, index: number) => {
                if (index === 0) return null;
                return <Timeline.Point ms={ms} className={"h-full border-r border-grid-dimmed"} />;
              }}
            </Timeline.EquallyDistribute>
            {/* The completed line  */}
            {rootSpanStatus !== "executing" && (
              <Timeline.Point
                ms={nanosecondsToMilliseconds(duration)}
                className={cn(
                  "h-full border-r",
                  rootSpanStatus === "completed" ? "border-success/30" : "border-error/30"
                )}
              />
            )}
            <TreeView
              scrollRef={timelineScrollRef}
              virtualizer={virtualizer}
              tree={events}
              nodes={nodes}
              getNodeProps={getNodeProps}
              getTreeProps={getTreeProps}
              parentClassName="h-full scrollbar-hide"
              renderNode={({ node, state, index, virtualizer, virtualItem }) => {
                return (
                  <Timeline.Row
                    key={index}
                    className={cn(
                      "group flex h-8 items-center",
                      state.selected
                        ? "bg-grid-dimmed hover:bg-grid-bright"
                        : "bg-transparent hover:bg-grid-dimmed"
                    )}
                    // onMouseOver={() => console.log(`hover ${index}`)}
                    onClick={(e) => {
                      toggleNodeSelection(node.id);
                    }}
                  >
                    {node.data.level === "TRACE" ? (
                      <>
                        {/* Add a span for the line, Make the vertical line the first one with 1px wide, and full height */}
                        {node.data.timelineEvents.map((event, eventIndex) =>
                          eventIndex === 0 ? (
                            <Timeline.Point
                              key={eventIndex}
                              ms={nanosecondsToMilliseconds(
                                queueAdjustedNs(event.offset, queuedDuration)
                              )}
                            >
                              {(ms) => (
                                <motion.div
                                  className={cn(
                                    "-ml-[0.5px] h-[0.5625rem] w-px rounded-none",
                                    eventBackgroundClassName(node.data)
                                  )}
                                  layoutId={`${node.id}-${event.name}`}
                                />
                              )}
                            </Timeline.Point>
                          ) : (
                            <Timeline.Point
                              key={eventIndex}
                              ms={nanosecondsToMilliseconds(
                                queueAdjustedNs(event.offset, queuedDuration)
                              )}
                              className="z-10"
                            >
                              {(ms) => (
                                <motion.div
                                  className={cn(
                                    "-ml-1 size-[0.3125rem] rounded-full border bg-background-bright",
                                    eventBorderClassName(node.data)
                                  )}
                                  layoutId={`${node.id}-${event.name}`}
                                />
                              )}
                            </Timeline.Point>
                          )
                        )}
                        {node.data.timelineEvents &&
                        node.data.timelineEvents[0] &&
                        node.data.timelineEvents[0].offset < node.data.offset ? (
                          <Timeline.Span
                            startMs={nanosecondsToMilliseconds(
                              queueAdjustedNs(node.data.timelineEvents[0].offset, queuedDuration)
                            )}
                            durationMs={nanosecondsToMilliseconds(
                              node.data.offset - node.data.timelineEvents[0].offset
                            )}
                          >
                            <motion.div
                              className={cn("h-px w-full", eventBackgroundClassName(node.data))}
                              layoutId={`mark-${node.id}`}
                            />
                          </Timeline.Span>
                        ) : null}
                        <SpanWithDuration
                          showDuration={state.selected ? true : showDurations}
                          startMs={nanosecondsToMilliseconds(
                            queueAdjustedNs(node.data.offset, queuedDuration)
                          )}
                          durationMs={
                            node.data.duration
                              ? nanosecondsToMilliseconds(node.data.duration)
                              : nanosecondsToMilliseconds(duration - node.data.offset)
                          }
                          node={node}
                        />
                      </>
                    ) : (
                      <Timeline.Point
                        ms={nanosecondsToMilliseconds(
                          queueAdjustedNs(node.data.offset, queuedDuration)
                        )}
                      >
                        {(ms) => (
                          <motion.div
                            className={cn(
                              "-ml-1 size-3 rounded-full border-2 border-background-bright",
                              eventBackgroundClassName(node.data)
                            )}
                            layoutId={node.id}
                          />
                        )}
                      </Timeline.Point>
                    )}
                  </Timeline.Row>
                );
              }}
              onScroll={(scrollTop) => {
                //sync the scroll to the tree
                if (treeScrollRef.current) {
                  treeScrollRef.current.scrollTop = scrollTop;
                }
              }}
            />
          </Timeline.Row>
        </Timeline.Row>
      </Timeline.Root>
    </div>
  );
}

function queueAdjustedNs(timeNs: number, queuedDurationNs: number | undefined) {
  if (queuedDurationNs) {
    return timeNs - queuedDurationNs;
  }

  return timeNs;
}

function NodeText({ node }: { node: TraceEvent }) {
  const className = "truncate";
  return (
    <Paragraph variant="small" className={cn(className)}>
      <SpanTitle {...node.data} size="small" />
    </Paragraph>
  );
}

function NodeStatusIcon({ node }: { node: TraceEvent }) {
  if (node.data.level !== "TRACE") return null;
  if (!node.data.style.variant) return null;

  if (node.data.style.variant === "warm") {
    return <WarmStartIconWithTooltip isWarmStart={true} className="size-4" />;
  } else if (node.data.style.variant === "cold") {
    return <WarmStartIconWithTooltip isWarmStart={false} className="size-4" />;
  }

  if (node.data.isCancelled) {
    return (
      <>
        <Paragraph variant="extra-small" className={runStatusClassNameColor("CANCELED")}>
          Canceled
        </Paragraph>
        <TaskRunStatusIcon status="CANCELED" className={cn("size-4")} />
      </>
    );
  }

  if (node.data.isError) {
    return <TaskRunStatusIcon status="COMPLETED_WITH_ERRORS" className={cn("size-4")} />;
  }

  if (node.data.isPartial) {
    return <TaskRunStatusIcon status={"EXECUTING"} className={cn("size-4")} />;
  }

  return <TaskRunStatusIcon status="COMPLETED_SUCCESSFULLY" className={cn("size-4")} />;
}

function TaskLine({ isError, isSelected }: { isError: boolean; isSelected: boolean }) {
  return <div className={cn("h-8 w-2 border-r border-grid-bright")} />;
}

function ShowParentLink({
  runFriendlyId,
  spanId,
  isRoot,
}: {
  runFriendlyId: string;
  spanId?: string;
  isRoot: boolean;
}) {
  const [mouseOver, setMouseOver] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { spanParam } = useParams();

  const span = spanId ? spanId : spanParam;

  return (
    <LinkButton
      variant="minimal/medium"
      to={
        span
          ? v3RunSpanPath(
              organization,
              project,
              environment,
              {
                friendlyId: runFriendlyId,
              },
              { spanId: span }
            )
          : v3RunPath(organization, project, environment, {
              friendlyId: runFriendlyId,
            })
      }
      onMouseEnter={() => setMouseOver(true)}
      onMouseLeave={() => setMouseOver(false)}
      fullWidth
      textAlignLeft
      shortcut={{ key: "p" }}
      className="flex-1"
    >
      {mouseOver ? (
        <ShowParentIconSelected className="h-4 w-4 text-indigo-500" />
      ) : (
        <ShowParentIcon className="h-4 w-4 text-charcoal-650" />
      )}
      <Paragraph
        variant="small"
        className={cn(mouseOver ? "text-indigo-500" : "text-charcoal-500")}
      >
        {isRoot ? "Show root run" : "Show parent run"}
      </Paragraph>
    </LinkButton>
  );
}

function LiveReloadingStatus({
  rootSpanCompleted,
  isLiveReloading,
  settingValue,
}: {
  rootSpanCompleted: boolean;
  isLiveReloading: boolean;
  settingValue: number;
}) {
  if (rootSpanCompleted) return null;

  return (
    <>
      {isLiveReloading ? (
        <div className="flex items-center gap-1">
          <PulsingDot />
          <Paragraph variant="extra-small" className="whitespace-nowrap text-blue-500">
            Live reloading
          </Paragraph>
        </div>
      ) : (
        <SimpleTooltip
          content={`Live reloading is disabled because you've exceeded ${settingValue} logs.`}
          button={
            <div className="flex items-center gap-1">
              <BoltSlashIcon className="size-3.5 text-text-dimmed" />
              <Paragraph variant="extra-small" className="whitespace-nowrap text-text-dimmed">
                Live reloading disabled
              </Paragraph>
            </div>
          }
        ></SimpleTooltip>
      )}
    </>
  );
}

function PulsingDot() {
  return (
    <span className="relative flex size-2">
      <span
        className={`absolute h-full w-full animate-ping rounded-full border border-blue-500 opacity-100 duration-1000`}
      />
      <span className={`size-2 rounded-full bg-blue-500`} />
    </span>
  );
}

function SpanWithDuration({
  showDuration,
  node,
  ...props
}: Timeline.SpanProps & { node: TraceEvent; showDuration: boolean }) {
  return (
    <Timeline.Span {...props}>
      <motion.div
        className={cn(
          "relative flex h-4 w-full min-w-0.5 items-center rounded-sm",
          eventBackgroundClassName(node.data)
        )}
        layoutId={node.id}
      >
        {node.data.isPartial && (
          <div
            className="absolute left-0 top-0 h-full w-full animate-tile-scroll rounded-sm opacity-30"
            style={{ backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }}
          />
        )}
        <div
          className={cn(
            "sticky left-0 z-10 transition group-hover:opacity-100",
            !showDuration && "opacity-0"
          )}
        >
          <div className="whitespace-nowrap rounded-sm px-1 py-0.5 text-xxs text-text-bright text-shadow-custom">
            {formatDurationMilliseconds(props.durationMs, {
              style: "short",
              maxDecimalPoints: props.durationMs < 1000 ? 0 : 1,
            })}
          </div>
        </div>
      </motion.div>
    </Timeline.Span>
  );
}

const edgeBoundary = 0.17;

function CurrentTimeIndicator({
  totalDuration,
  rootStartedAt,
  queuedDurationNs,
}: {
  totalDuration: number;
  rootStartedAt: Date | undefined;
  queuedDurationNs: number | undefined;
}) {
  return (
    <Timeline.FollowCursor>
      {(ms) => {
        const ratio = ms / nanosecondsToMilliseconds(totalDuration);
        let offset = 0.5;
        if (ratio < edgeBoundary) {
          offset = lerp(0, 0.5, ratio / edgeBoundary);
        } else if (ratio > 1 - edgeBoundary) {
          offset = lerp(0.5, 1, (ratio - (1 - edgeBoundary)) / edgeBoundary);
        }

        const currentTime = rootStartedAt
          ? new Date(
              rootStartedAt.getTime() + ms + nanosecondsToMilliseconds(queuedDurationNs ?? 0)
            )
          : undefined;
        const currentTimeComponent = currentTime ? <DateTimeShort date={currentTime} /> : <></>;

        return (
          <div className="relative z-50 flex h-full flex-col">
            <div className="relative flex h-6 items-end">
              <div
                className="absolute w-fit whitespace-nowrap rounded-sm border border-charcoal-600 bg-charcoal-750 px-1 py-0.5 text-xxs tabular-nums text-text-bright"
                style={{
                  left: `${offset * 100}%`,
                  transform: `translateX(-${offset * 100}%)`,
                }}
              >
                {currentTimeComponent ? (
                  <span>
                    {formatDurationMilliseconds(ms, {
                      style: "short",
                      maxDecimalPoints: ms < 1000 ? 0 : 1,
                    })}
                    <span className="mx-1 text-text-dimmed">–</span>
                    {currentTimeComponent}
                  </span>
                ) : (
                  <>
                    {formatDurationMilliseconds(ms, {
                      style: "short",
                      maxDecimalPoints: ms < 1000 ? 0 : 1,
                    })}
                  </>
                )}
              </div>
            </div>
            <div className="w-px grow border-r border-charcoal-600" />
          </div>
        );
      }}
    </Timeline.FollowCursor>
  );
}

function KeyboardShortcuts({
  expandAllBelowDepth,
  collapseAllBelowDepth,
  toggleExpandLevel,
  setShowDurations,
}: {
  expandAllBelowDepth: (depth: number) => void;
  collapseAllBelowDepth: (depth: number) => void;
  toggleExpandLevel: (depth: number) => void;
  setShowDurations: (show: (show: boolean) => boolean) => void;
}) {
  return (
    <>
      <ArrowKeyShortcuts />
      <ShortcutWithAction
        shortcut={{ key: "e" }}
        action={() => expandAllBelowDepth(0)}
        title="Expand all"
      />
      <ShortcutWithAction
        shortcut={{ key: "w" }}
        action={() => collapseAllBelowDepth(1)}
        title="Collapse all"
      />
      <NumberShortcuts toggleLevel={(number) => toggleExpandLevel(number)} />
    </>
  );
}

function ArrowKeyShortcuts() {
  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={{ key: "arrowup" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowdown" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowleft" }} variant="medium" className="ml-0 mr-0" />
      <ShortcutKey shortcut={{ key: "arrowright" }} variant="medium" className="ml-0 mr-0" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Navigate
      </Paragraph>
    </div>
  );
}

function ShortcutWithAction({
  shortcut,
  title,
  action,
}: {
  shortcut: Shortcut;
  title: string;
  action: () => void;
}) {
  useShortcutKeys({
    shortcut,
    action,
  });

  return (
    <div className="flex items-center gap-0.5">
      <ShortcutKey shortcut={shortcut} variant="medium" className="ml-0 mr-0" />
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        {title}
      </Paragraph>
    </div>
  );
}

function NumberShortcuts({ toggleLevel }: { toggleLevel: (depth: number) => void }) {
  useHotkeys(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], (event, hotkeysEvent) => {
    toggleLevel(Number(event.key));
  });

  return (
    <div className="flex items-center gap-0.5">
      <span className={cn(variants.medium, "ml-0 mr-0")}>0</span>
      <span className="text-[0.75rem] text-text-dimmed">–</span>
      <span className={cn(variants.medium, "ml-0 mr-0")}>9</span>
      <Paragraph variant="extra-small" className="ml-1.5 whitespace-nowrap">
        Toggle level
      </Paragraph>
    </div>
  );
}

function SearchField({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("");

  const updateFilterText = useDebounce((text: string) => {
    onChange(text);
  }, 250);

  const updateValue = useCallback((value: string) => {
    setValue(value);
    updateFilterText(value);
  }, []);

  return (
    <Input
      placeholder="Search log"
      variant="tertiary"
      icon={MagnifyingGlassIcon}
      fullWidth={true}
      value={value}
      onChange={(e) => updateValue(e.target.value)}
    />
  );
}

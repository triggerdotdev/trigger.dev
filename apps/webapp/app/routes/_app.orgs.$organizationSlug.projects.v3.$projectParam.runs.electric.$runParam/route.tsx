import {
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  InformationCircleIcon,
  LockOpenIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  StopCircleIcon,
} from "@heroicons/react/20/solid";
import type { Location } from "@remix-run/react";
import { useParams } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { Virtualizer } from "@tanstack/react-virtual";
import {
  formatDurationMilliseconds,
  millisecondsToNanoseconds,
  nanosecondsToMilliseconds,
} from "@trigger.dev/core/v3";
import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { ClientOnly } from "remix-utils/client-only";
import { ShowParentIcon, ShowParentIconSelected } from "~/assets/icons/ShowParentIcon";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
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
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import * as Timeline from "~/components/primitives/Timeline";
import { TreeView, UseTreeStateOutput, useTree } from "~/components/primitives/TreeView/TreeView";
import { NodesState } from "~/components/primitives/TreeView/reducer";
import { CancelRunDialog } from "~/components/runs/v3/CancelRunDialog";
import { ReplayRunDialog } from "~/components/runs/v3/ReplayRunDialog";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { RunInspector } from "~/components/runs/v3/RunInspector";
import { SpanInspector } from "~/components/runs/v3/SpanInspector";
import { SpanTitle, eventBackgroundClassName } from "~/components/runs/v3/SpanTitle";
import { TaskRunStatusIcon, runStatusClassNameColor } from "~/components/runs/v3/TaskRunStatus";
import { useAppOrigin } from "~/hooks/useAppOrigin";
import { useDebounce } from "~/hooks/useDebounce";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useReplaceSearchParams } from "~/hooks/useReplaceSearchParams";
import { Shortcut, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useSyncRunPage } from "~/hooks/useSyncRunPage";
import { Trace, TraceEvent } from "~/hooks/useSyncTrace";
import { RawRun } from "~/hooks/useSyncTraceRuns";
import { useUser } from "~/hooks/useUser";
import { Run, RunPresenter } from "~/presenters/v3/RunPresenterElectric.server";
import { getResizableSnapshot } from "~/services/resizablePanel.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { lerp } from "~/utils/lerp";
import {
  v3BillingPath,
  v3RunParamsSchema,
  v3RunPath,
  v3RunSpanPath,
  v3RunsPath,
} from "~/utils/pathBuilder";
import {
  TraceSpan,
  createSpanFromEvents,
  createTraceTreeFromEvents,
  prepareTrace,
} from "~/utils/taskEvent";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, runParam } = v3RunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const result = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    runFriendlyId: runParam,
  });

  //resizable settings
  const parent = await getResizableSnapshot(request, resizableSettings.parent.autosaveId);
  const tree = await getResizableSnapshot(request, resizableSettings.tree.autosaveId);

  return typedjson({
    run: result.run,
    resizable: {
      parent,
      tree,
    },
  });
};

type LoaderData = UseDataFunctionReturn<typeof loader>;

export default function Page() {
  const { run, resizable } = useTypedLoaderData<typeof loader>();

  const user = useUser();
  const organization = useOrganization();
  const project = useProject();

  const usernameForEnv = user.id !== run.environment.userId ? run.environment.userName : undefined;

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{
            to: v3RunsPath(organization, project),
            text: "Runs",
          }}
          title={
            <div className="flex items-center gap-3">
              <span>Run #{run.number}</span>
              <EnvironmentLabel
                size="large"
                environment={run.environment}
                userName={usernameForEnv}
              />
            </div>
          }
        />
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
                { friendlyId: run.friendlyId },
                { spanId: run.spanId }
              )}
            />
          </Dialog>
          {run.isFinished ? null : (
            <Dialog key={`cancel-${run.friendlyId}`}>
              <DialogTrigger asChild>
                <Button variant="danger/small" LeadingIcon={StopCircleIcon}>
                  Cancel run
                </Button>
              </DialogTrigger>
              <CancelRunDialog
                runFriendlyId={run.friendlyId}
                redirectPath={v3RunSpanPath(
                  organization,
                  project,
                  { friendlyId: run.friendlyId },
                  { spanId: run.spanId }
                )}
              />
            </Dialog>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className={cn("grid h-full max-h-full grid-cols-1 overflow-hidden")}>
          <ClientOnly fallback={<Loading />}>
            {() => <Panels run={run} resizable={resizable} />}
          </ClientOnly>
        </div>
      </PageBody>
    </>
  );
}

type InspectorState =
  | {
      type: "span";
      span?: TraceSpan;
    }
  | {
      type: "run";
      run?: RawRun;
      span?: TraceSpan;
    }
  | undefined;

function Panels({ resizable, run: originalRun }: LoaderData) {
  const { searchParams, replaceSearchParam } = useReplaceSearchParams();
  const selectedSpanId = searchParams.get("span") ?? undefined;

  const appOrigin = useAppOrigin();
  const { isUpToDate, events, runs } = useSyncRunPage({
    origin: appOrigin,
    traceId: originalRun.traceId,
  });

  const initialLoad = !isUpToDate || !runs;

  const trace = useMemo(() => {
    if (!events) return undefined;
    const preparedEvents = prepareTrace(events);
    if (!preparedEvents) return undefined;
    return createTraceTreeFromEvents(preparedEvents, originalRun.spanId);
  }, [events, originalRun.spanId]);

  const inspectorState = useMemo<InspectorState>(() => {
    if (originalRun.logsDeletedAt) {
      return {
        type: "run",
        run: runs?.find((r) => r.friendlyId === originalRun.friendlyId),
      };
    }

    if (selectedSpanId) {
      if (runs && runs.length > 0) {
        const spanRun = runs.find((r) => r.spanId === selectedSpanId);
        if (spanRun && events) {
          const span = createSpanFromEvents(events, selectedSpanId);
          return {
            type: "run",
            run: spanRun,
            span,
          };
        }
      }

      if (!events) {
        return {
          type: "span",
          span: undefined,
        };
      }

      const span = createSpanFromEvents(events, selectedSpanId);
      return {
        type: "span",
        span,
      };
    }
  }, [selectedSpanId, runs, events]);

  return (
    <ResizablePanelGroup
      autosaveId={resizableSettings.parent.autosaveId}
      // snapshot={resizable.parent}
      className="h-full max-h-full"
    >
      <ResizablePanel id={resizableSettings.parent.main.id} min={resizableSettings.parent.main.min}>
        {initialLoad ? (
          <Loading />
        ) : (
          <TraceView
            run={originalRun}
            environmentType={originalRun.environment.type}
            trace={trace}
            selectedSpanId={selectedSpanId}
            replaceSearchParam={replaceSearchParam}
          />
        )}
      </ResizablePanel>
      <ResizableHandle id={resizableSettings.parent.handleId} />
      {inspectorState ? (
        <ResizablePanel
          id={resizableSettings.parent.inspector.id}
          default={resizableSettings.parent.inspector.default}
          min={resizableSettings.parent.inspector.min}
          isStaticAtRest
        >
          {inspectorState.type === "span" ? (
            <SpanInspector
              runParam={originalRun.friendlyId}
              span={inspectorState.span}
              closePanel={!originalRun.logsDeletedAt ? () => replaceSearchParam("span") : undefined}
            />
          ) : inspectorState.type === "run" ? (
            <RunInspector
              runParam={originalRun.friendlyId}
              run={inspectorState.run}
              closePanel={!originalRun.logsDeletedAt ? () => replaceSearchParam("span") : undefined}
            />
          ) : null}
        </ResizablePanel>
      ) : null}
    </ResizablePanelGroup>
  );
}

type TraceData = {
  run: Run;
  environmentType: RuntimeEnvironmentType;
  trace?: Trace;
  selectedSpanId: string | undefined;
  replaceSearchParam: (key: string, value?: string) => void;
};

function TraceView({ run, environmentType, trace, selectedSpanId, replaceSearchParam }: TraceData) {
  const changeToSpan = useDebounce((selectedSpan: string) => {
    replaceSearchParam("span", selectedSpan);
  }, 100);

  if (!trace) {
    return <NoLogsView run={run} />;
  }

  const { events, parentRunFriendlyId, duration, rootSpanStatus, rootStartedAt } = trace;

  return (
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
      environmentType={environmentType}
    />
  );
}

function NoLogsView({ run }: { run: Run }) {
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
    <div className="grid h-full place-items-center">
      {daysSinceCompleted === undefined ? (
        <InfoPanel variant="info" icon={InformationCircleIcon} title="We delete old logs">
          <Paragraph variant="small">
            We tidy up older logs to keep things running smoothly.
          </Paragraph>
        </InfoPanel>
      ) : isWithinLogRetention ? (
        <InfoPanel variant="info" icon={InformationCircleIcon} title="These logs have been deleted">
          <Paragraph variant="small">
            Your log retention is {logRetention} days but these logs had already been deleted. From
            now on only logs from runs that completed {logRetention} days ago will be deleted.
          </Paragraph>
        </InfoPanel>
      ) : daysSinceCompleted <= 30 ? (
        <InfoPanel
          variant="upgrade"
          icon={LockOpenIcon}
          iconClassName="text-indigo-500"
          title="Unlock longer log retention"
          to={v3BillingPath(organization)}
          buttonLabel="Upgrade"
        >
          <Paragraph variant="small">
            The logs for this run have been deleted because the run completed {daysSinceCompleted}{" "}
            days ago.
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
  environmentType: RuntimeEnvironmentType;
};

function TasksTreeView({
  events,
  selectedId,
  parentRunFriendlyId,
  onSelectedIdChanged,
  totalDuration,
  rootSpanStatus,
  rootStartedAt,
  environmentType,
}: TasksTreeViewProps) {
  const [filterText, setFilterText] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [showDurations, setShowDurations] = useState(true);
  const [scale, setScale] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);

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
    tree: events,
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
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-3">
        <SearchField onChange={setFilterText} />
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
              {parentRunFriendlyId ? (
                <ShowParentLink runFriendlyId={parentRunFriendlyId} />
              ) : (
                <Paragraph variant="small" className="flex-1 text-charcoal-500">
                  This is the root task
                </Paragraph>
              )}
              <LiveReloadingStatus rootSpanCompleted={rootSpanStatus !== "executing"} />
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
              renderNode={({ node, state }) => (
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
                      <div className="flex items-center gap-2 overflow-x-hidden">
                        <RunIcon
                          name={node.data.style?.icon}
                          spanName={node.data.message}
                          className="h-4 min-h-4 w-4 min-w-4"
                        />
                        <NodeText node={node} />
                        {node.data.isRoot && <Badge variant="outline-rounded">Root</Badge>}
                      </div>
                      <div className="flex items-center gap-1">
                        <NodeStatusIcon node={node} />
                      </div>
                    </div>
                  </div>
                  {events.length === 1 && environmentType === "DEVELOPMENT" && (
                    <ConnectedDevWarning />
                  )}
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
  "totalDuration" | "rootSpanStatus" | "events" | "rootStartedAt"
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
}: TimelineViewProps) {
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const initialTimelineDimensions = useInitialDimensions(timelineContainerRef);
  const minTimelineWidth = initialTimelineDimensions?.width ?? 300;
  const maxTimelineWidth = minTimelineWidth * 10;

  //we want to live-update the duration if the root span is still executing
  const [duration, setDuration] = useState(totalDuration);
  useEffect(() => {
    if (rootSpanStatus !== "executing" || !rootStartedAt) {
      setDuration(totalDuration);
      return;
    }

    const interval = setInterval(() => {
      setDuration(millisecondsToNanoseconds(Date.now() - rootStartedAt.getTime()));
    }, 500);

    return () => clearInterval(interval);
  }, [totalDuration, rootSpanStatus]);

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
        <CurrentTimeIndicator totalDuration={duration} />

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
                      <SpanWithDuration
                        showDuration={state.selected ? true : showDurations}
                        startMs={nanosecondsToMilliseconds(node.data.offset)}
                        durationMs={
                          node.data.duration
                            ? nanosecondsToMilliseconds(node.data.duration)
                            : nanosecondsToMilliseconds(duration - node.data.offset)
                        }
                        node={node}
                      />
                    ) : (
                      <Timeline.Point ms={nanosecondsToMilliseconds(node.data.offset)}>
                        {(ms) => (
                          <motion.div
                            className={cn(
                              "-ml-1 h-3 w-3 rounded-full border-2 border-background-bright",
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
  if (node.data.style.variant !== "primary") return null;

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

function ShowParentLink({ runFriendlyId }: { runFriendlyId: string }) {
  const [mouseOver, setMouseOver] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const { spanParam } = useParams();

  return (
    <LinkButton
      variant="minimal/medium"
      to={
        spanParam
          ? v3RunSpanPath(
              organization,
              project,
              {
                friendlyId: runFriendlyId,
              },
              { spanId: spanParam }
            )
          : v3RunPath(organization, project, {
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
        Show parent items
      </Paragraph>
    </LinkButton>
  );
}

function LiveReloadingStatus({ rootSpanCompleted }: { rootSpanCompleted: boolean }) {
  if (rootSpanCompleted) return null;

  return (
    <div className="flex items-center gap-1">
      <PulsingDot />
      <Paragraph variant="extra-small" className="whitespace-nowrap text-blue-500">
        Live reloading
      </Paragraph>
    </div>
  );
}

function PulsingDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span
        className={`absolute h-full w-full animate-ping rounded-full border border-blue-500 opacity-100 duration-1000`}
      />
      <span className={`h-2 w-2 rounded-full bg-blue-500`} />
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
          "relative flex h-4 w-full min-w-[2px] items-center rounded-sm",
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
            "sticky left-0 z-10 transition-opacity group-hover:opacity-100",
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

const edgeBoundary = 0.05;

function CurrentTimeIndicator({ totalDuration }: { totalDuration: number }) {
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
                {formatDurationMilliseconds(ms, {
                  style: "short",
                  maxDecimalPoints: ms < 1000 ? 0 : 1,
                })}
              </div>
            </div>
            <div className="w-px grow border-r border-charcoal-600" />
          </div>
        );
      }}
    </Timeline.FollowCursor>
  );
}

function ConnectedDevWarning() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(true);
    }, 6000);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={cn(
        "mt-2 flex items-center overflow-hidden pl-5 pr-2 transition-opacity duration-500",
        isVisible ? "opacity-100" : "h-0 opacity-0"
      )}
    >
      <Callout variant="info" className="mt-2">
        <div className="flex flex-col gap-1">
          <Paragraph variant="small">
            Runs usually start within 2 seconds in{" "}
            <EnvironmentLabel environment={{ type: "DEVELOPMENT" }} />. Check you're running the
            CLI: <InlineCode className="whitespace-nowrap">npx trigger.dev@latest dev</InlineCode>
          </Paragraph>
        </div>
      </Callout>
    </div>
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
      icon="search"
      fullWidth={true}
      value={value}
      onChange={(e) => updateValue(e.target.value)}
    />
  );
}

export function Loading() {
  return (
    <div className="grid h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden">
      <div className="mx-3 flex items-center gap-2 border-b border-grid-dimmed">
        <Spinner className="size-4" />
        <Paragraph variant="extra-small" className="flex items-center gap-2">
          Loading logs
        </Paragraph>
      </div>
      <div></div>
    </div>
  );
}

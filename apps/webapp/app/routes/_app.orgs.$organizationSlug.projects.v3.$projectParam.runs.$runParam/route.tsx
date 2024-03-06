import {
  ChevronDownIcon,
  ChevronRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  NoSymbolIcon,
} from "@heroicons/react/20/solid";
import { Link, Outlet, useNavigate, useRevalidator } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDurationMilliseconds, nanosecondsToMilliseconds } from "@trigger.dev/core/v3";
import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ShowParentIcon, ShowParentIconSelected } from "~/assets/icons/ShowParentIcon";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Slider } from "~/components/primitives/Slider";
import { Switch } from "~/components/primitives/Switch";
import * as Timeline from "~/components/primitives/Timeline";
import { TreeView, useTree } from "~/components/primitives/TreeView/TreeView";
import { LiveCountUp, LiveTimer } from "~/components/runs/v3/LiveTimer";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { SpanTitle, eventBackgroundClassName } from "~/components/runs/v3/SpanTitle";
import { TaskRunStatusIcon, runStatusClassNameColor } from "~/components/runs/v3/TaskRunStatus";
import { useDebounce } from "~/hooks/useDebounce";
import { useEventSource } from "~/hooks/useEventSource";
import { useInitialDimensions } from "~/hooks/useInitialDimensions";
import { useOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunEvent, RunPresenter } from "~/presenters/v3/RunPresenter.server";
import { getResizableRunSettings, setResizableRunSettings } from "~/services/resizablePanel";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { lerp } from "~/utils/lerp";
import {
  v3RunParamsSchema,
  v3RunPath,
  v3RunSpanPath,
  v3RunStreamingPath,
  v3RunsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, runParam } = v3RunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const { run, events, parentRunFriendlyId, duration, rootSpanStatus } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    runFriendlyId: runParam,
  });

  //resizable settings
  const resizeSettings = await getResizableRunSettings(request);

  return typedjson({
    run,
    events,
    parentRunFriendlyId,
    resizeSettings,
    duration,
    rootSpanStatus,
  });
};

function getSpanId(path: string): string | undefined {
  const regex = /spans\/([^\/]*)/;
  const match = path.match(regex);
  return match ? match[1] : undefined;
}

export default function Page() {
  const { run, events, parentRunFriendlyId, resizeSettings, duration, rootSpanStatus } =
    useTypedLoaderData<typeof loader>();
  const navigate = useNavigate();
  const organization = useOrganization();
  const pathName = usePathName();
  const project = useProject();
  const user = useUser();

  const selectedSpanId = getSpanId(pathName);

  const changeToSpan = useDebounce((selectedSpan: string) => {
    navigate(v3RunSpanPath(organization, project, run, { spanId: selectedSpan }));
  }, 250);

  const usernameForEnv = user.id !== run.environment.userId ? run.environment.userName : undefined;

  const revalidator = useRevalidator();
  const streamedEvents = useEventSource(v3RunStreamingPath(organization, project, run), {
    event: "message",
  });
  useEffect(() => {
    if (streamedEvents !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [streamedEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{
            to: v3RunsPath(organization, project),
            text: "Runs",
          }}
          title={`Run #${run.number}`}
        />
        <PageAccessories>
          <EnvironmentLabel size="large" environment={run.environment} userName={usernameForEnv} />
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className={cn("grid h-full max-h-full grid-cols-1 overflow-hidden")}>
          {selectedSpanId === undefined ? (
            <TasksTreeView
              selectedId={selectedSpanId}
              key={events[0]?.id ?? "-"}
              events={events}
              parentRunFriendlyId={parentRunFriendlyId}
              onSelectedIdChanged={(selectedSpan) => {
                //instantly close the panel if no span is selected
                if (!selectedSpan) {
                  navigate(v3RunPath(organization, project, run));
                  return;
                }

                changeToSpan(selectedSpan);
              }}
              totalDuration={duration}
              rootSpanStatus={rootSpanStatus}
            />
          ) : (
            <ResizablePanelGroup
              direction="horizontal"
              className="h-full max-h-full"
              onLayout={(layout) => {
                if (layout.length !== 2) return;
                setResizableRunSettings(document, layout);
              }}
            >
              <ResizablePanel order={1} minSize={30} defaultSize={resizeSettings.layout?.[0]}>
                <TasksTreeView
                  selectedId={selectedSpanId}
                  key={events[0]?.id ?? "-"}
                  events={events}
                  parentRunFriendlyId={parentRunFriendlyId}
                  onSelectedIdChanged={(selectedSpan) => {
                    //instantly close the panel if no span is selected
                    if (!selectedSpan) {
                      navigate(v3RunPath(organization, project, run));
                      return;
                    }

                    changeToSpan(selectedSpan);
                  }}
                  totalDuration={duration}
                  rootSpanStatus={rootSpanStatus}
                />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel order={2} minSize={30} defaultSize={resizeSettings.layout?.[1]}>
                <Outlet key={selectedSpanId} />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      </PageBody>
    </>
  );
}

const tickCount = 5;

function TasksTreeView({
  events,
  selectedId,
  parentRunFriendlyId,
  onSelectedIdChanged,
  totalDuration,
  rootSpanStatus,
}: {
  events: RunEvent[];
  selectedId?: string;
  parentRunFriendlyId?: string;
  onSelectedIdChanged: (selectedId: string | undefined) => void;
  totalDuration: number;
  rootSpanStatus: "executing" | "completed" | "failed";
}) {
  const [filterText, setFilterText] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [showDurations, setShowDurations] = useState(false);
  const [scale, setScale] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const timelineContainerRef = useRef<HTMLDivElement>(null);
  const initialTimelineDimensions = useInitialDimensions(timelineContainerRef);

  const {
    nodes,
    getTreeProps,
    getNodeProps,
    toggleNodeSelection,
    toggleExpandNode,
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
    filter: (node) => {
      const nodePassesErrorTest = (errorsOnly && node.data.isError) || !errorsOnly;
      if (!nodePassesErrorTest) return false;

      if (filterText === "") return true;
      if (node.data.message.toLowerCase().includes(filterText.toLowerCase())) {
        return true;
      }
      return false;
    },
  });

  return (
    <div className="grid h-full grid-rows-[2.5rem_1fr] overflow-hidden">
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Input
          placeholder="Search log"
          variant="tertiary"
          icon="search"
          fullWidth={true}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <LiveReloadingStatus rootSpanCompleted={rootSpanStatus !== "executing"} />
          <Switch
            variant="small"
            label="Errors only"
            checked={errorsOnly}
            onCheckedChange={(e) => setErrorsOnly(e.valueOf())}
          />
          <Switch
            variant="small"
            label="Show durations"
            checked={showDurations}
            onCheckedChange={(e) => setShowDurations(e.valueOf())}
          />
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
      <ResizablePanelGroup
        direction="horizontal"
        onLayout={(layout) => {
          if (layout.length !== 2) return;
          setResizableRunSettings(document, layout);
        }}
      >
        {/* Tree list */}
        <ResizablePanel order={1} minSize={20} defaultSize={50} className="pl-3">
          <div className="grid h-full grid-rows-[2rem_1fr] overflow-hidden">
            <div className="flex items-center">
              {parentRunFriendlyId ? (
                <ShowParentLink runFriendlyId={parentRunFriendlyId} />
              ) : (
                <Paragraph variant="small" className="text-charcoal-500">
                  This is the root task
                </Paragraph>
              )}
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
                <div
                  className={cn(
                    "flex h-8 cursor-pointer items-center rounded-l-sm pr-2",
                    state.selected
                      ? "bg-grid-dimmed hover:bg-grid-bright"
                      : "bg-transparent hover:bg-grid-dimmed"
                  )}
                  onClick={() => {
                    toggleNodeSelection(node.id);
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
                        node.hasChildren &&
                          (node.data.isError ? "hover:bg-rose-500/30" : "hover:bg-charcoal-800")
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpandNode(node.id);
                        selectNode(node.id);
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
                      <RunIcon name={node.data.style?.icon} className="h-4 min-h-4 w-4 min-w-4" />
                      <NodeText node={node} />
                      {node.data.isRoot && <Badge variant="outline-rounded">Root</Badge>}
                    </div>
                    <div className="flex items-center gap-1">
                      <NodeStatusIcon node={node} />
                    </div>
                  </div>
                </div>
              )}
              onScroll={(scrollTop) => {
                //sync the scroll to the tree
                if (
                  timelineScrollRef.current &&
                  timelineScrollRef.current.scrollTop !== scrollTop
                ) {
                  timelineScrollRef.current.scrollTop = scrollTop;
                }
              }}
            />
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        {/* Timeline */}
        <ResizablePanel order={2} minSize={20} defaultSize={50}>
          <div
            className="h-full overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
            ref={timelineContainerRef}
          >
            <Timeline.Root
              durationMs={nanosecondsToMilliseconds(totalDuration * 1.05)}
              scale={scale}
              className="h-full overflow-hidden"
              minWidth={initialTimelineDimensions?.width ?? 300}
              maxWidth={2000}
            >
              {/* Follows the cursor */}
              <CurrentTimeIndicator totalDuration={totalDuration} />

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
                        ms={nanosecondsToMilliseconds(totalDuration)}
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
                          <Timeline.Point
                            ms={ms}
                            className={"h-full border-r border-grid-dimmed"}
                          />
                        );
                      }}
                    </Timeline.EquallyDistribute>
                    <Timeline.Point
                      ms={nanosecondsToMilliseconds(totalDuration)}
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
                      return (
                        <Timeline.Point ms={ms} className={"h-full border-r border-grid-dimmed"} />
                      );
                    }}
                  </Timeline.EquallyDistribute>
                  {/* The completed line  */}
                  {rootSpanStatus !== "executing" && (
                    <Timeline.Point
                      ms={nanosecondsToMilliseconds(totalDuration)}
                      className={cn(
                        "h-full border-r",
                        rootSpanStatus === "completed" ? "border-success/30" : "border-error/30"
                      )}
                    />
                  )}
                  <TreeView
                    parentRef={parentRef}
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
                              durationMs={nanosecondsToMilliseconds(node.data.duration)}
                              node={node}
                            />
                          ) : (
                            <Timeline.Point
                              ms={nanosecondsToMilliseconds(node.data.offset)}
                              className={cn(
                                "-ml-1 h-3 w-3 rounded-full border-2 border-background-bright",
                                eventBackgroundClassName(node.data)
                              )}
                            />
                          )}
                        </Timeline.Row>
                      );
                    }}
                    onScroll={(scrollTop) => {
                      //sync the scroll to the tree
                      if (treeScrollRef.current && treeScrollRef.current.scrollTop !== scrollTop) {
                        treeScrollRef.current.scrollTop = scrollTop;
                      }
                    }}
                  />
                </Timeline.Row>
              </Timeline.Row>
            </Timeline.Root>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function NodeText({ node }: { node: RunEvent }) {
  const className = "truncate";
  return (
    <Paragraph variant="small" className={cn(className)}>
      <SpanTitle {...node.data} size="small" />
    </Paragraph>
  );
}
function NodeStatusIcon({ node }: { node: RunEvent }) {
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
    return <TaskRunStatusIcon status="FAILED" className={cn("size-4")} />;
  }

  if (node.data.isPartial) {
    return <TaskRunStatusIcon status={"EXECUTING"} className={cn("size-4")} />;
  }

  return <TaskRunStatusIcon status="COMPLETED" className={cn("size-4")} />;
}

function TaskLine({ isError, isSelected }: { isError: boolean; isSelected: boolean }) {
  return (
    <div
      className={cn("h-8 w-2 border-r", isError ? "border-rose-500/10" : "border-charcoal-800")}
    />
  );
}

function ShowParentLink({ runFriendlyId }: { runFriendlyId: string }) {
  const [mouseOver, setMouseOver] = useState(false);
  const organization = useOrganization();
  const project = useProject();

  return (
    <Link
      to={v3RunPath(organization, project, {
        friendlyId: runFriendlyId,
      })}
      onMouseEnter={() => setMouseOver(true)}
      onMouseLeave={() => setMouseOver(false)}
      className="mt-1 flex h-8 items-center gap-2"
    >
      {mouseOver ? (
        <ShowParentIconSelected className="h-4 w-4 text-indigo-500" />
      ) : (
        <ShowParentIcon className="text-charcoal-650 h-4 w-4" />
      )}
      <Paragraph
        variant="small"
        className={cn(mouseOver ? "text-indigo-500" : "text-charcoal-500")}
      >
        Show parent items
      </Paragraph>
    </Link>
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
}: Timeline.SpanProps & { node: RunEvent; showDuration: boolean }) {
  return (
    <Timeline.Span {...props}>
      <div
        className={cn(
          "relative flex h-4 w-full min-w-[2px] items-center rounded-sm",
          eventBackgroundClassName(node.data)
        )}
      >
        {node.data.isPartial && (
          <div
            className="absolute left-0 top-0 h-full w-full animate-tile-scroll rounded-sm opacity-50"
            style={{ backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }}
          />
        )}
        <div
          className={cn(
            "sticky left-0 z-10 transition group-hover:opacity-100",
            !showDuration && "opacity-0"
          )}
        >
          <div className="rounded-sm px-1 py-0.5 text-xxs text-text-bright text-shadow-custom">
            {formatDurationMilliseconds(props.durationMs, {
              style: "short",
              maxDecimalPoints: props.durationMs < 1000 ? 0 : 1,
            })}
          </div>
        </div>
      </div>
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

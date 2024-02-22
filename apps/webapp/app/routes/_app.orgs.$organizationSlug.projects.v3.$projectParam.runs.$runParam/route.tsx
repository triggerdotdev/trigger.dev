import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/20/solid";
import { Link, Outlet, useNavigate, useParams, useSubmit } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { formatDuration, formatDurationNanoseconds } from "@trigger.dev/core/v3";
import { useCallback, useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ShowParentIcon, ShowParentIconSelected } from "~/assets/icons/ShowParentIcon";
import { PageBody } from "~/components/layout/AppLayout";
import { Input } from "~/components/primitives/Input";
import { PageHeader, PageTitle, PageTitleRow } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { TreeView, useTree } from "~/components/primitives/TreeView/TreeView";
import { eventTextClassName } from "~/components/runs/v3/EventText";
import { LiveTimer } from "~/components/runs/v3/LiveTimer";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { useDebounce } from "~/hooks/useDebounce";
import { useOrganization } from "~/hooks/useOrganizations";
import { usePathName } from "~/hooks/usePathName";
import { useProject } from "~/hooks/useProject";
import { useThrottle } from "~/hooks/useThrottle";
import { RunEvent, RunPresenter } from "~/presenters/v3/RunPresenter.server";
import { getResizableRunSettings, setResizableRunSettings } from "~/services/resizablePanel";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { v3RunParamsSchema, v3RunPath, v3RunSpanPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, runParam } = v3RunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const { run, events, parentRunFriendlyId } = await presenter.call({
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
  });
};

function getSpanId(path: string): string | undefined {
  const regex = /spans\/([^\/]*)/;
  const match = path.match(regex);
  return match ? match[1] : undefined;
}

export default function Page() {
  const { run, events, parentRunFriendlyId, resizeSettings } = useTypedLoaderData<typeof loader>();
  const navigate = useNavigate();
  const organization = useOrganization();
  const pathName = usePathName();
  const project = useProject();

  const selectedSpanId = getSpanId(pathName);

  const changeToSpan = useDebounce((selectedSpan: string) => {
    navigate(v3RunSpanPath(organization, project, run, { spanId: selectedSpan }));
  }, 250);

  return (
    <>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title={`Run #${run.number}`} />
        </PageTitleRow>
      </PageHeader>
      <PageBody scrollable={false}>
        <div className={cn("grid h-full max-h-full grid-cols-1")}>
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full max-h-full"
            onLayout={(layout) => {
              if (layout.length !== 2) return;
              setResizableRunSettings(document, layout);
            }}
          >
            <ResizablePanel
              order={1}
              minSize={30}
              defaultSize={selectedSpanId ? resizeSettings.layout?.[0] : 100}
            >
              <div className="h-full overflow-y-clip">
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
                />
              </div>
            </ResizablePanel>
            {selectedSpanId !== undefined && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel order={2} minSize={30} defaultSize={resizeSettings.layout?.[1]}>
                  <Outlet key={selectedSpanId} />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      </PageBody>
    </>
  );
}

function TasksTreeView({
  events,
  selectedId,
  parentRunFriendlyId,
  onSelectedIdChanged,
}: {
  events: RunEvent[];
  selectedId?: string;
  parentRunFriendlyId?: string;
  onSelectedIdChanged: (selectedId: string | undefined) => void;
}) {
  const [filterText, setFilterText] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

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
    <div className="px-3">
      <div className="flex h-8 items-center justify-between gap-2 border-b border-slate-850">
        <Input
          placeholder="Search log"
          variant="tertiary"
          icon="search"
          fullWidth={true}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        <Switch
          variant="small"
          label="Errors only"
          checked={errorsOnly}
          onCheckedChange={(e) => setErrorsOnly(e.valueOf())}
        />
      </div>
      {parentRunFriendlyId && <ShowParentLink runFriendlyId={parentRunFriendlyId} />}
      <TreeView
        parentRef={parentRef}
        virtualizer={virtualizer}
        autoFocus
        tree={events}
        nodes={nodes}
        getNodeProps={getNodeProps}
        getTreeProps={getTreeProps}
        parentClassName="h-full mt-2"
        renderNode={({ node, state, index, virtualizer, virtualItem }) => (
          <div
            className={cn(
              "flex h-8 cursor-pointer items-center rounded-sm border border-transparent",
              node.data.isError ? "bg-rose-500/10 hover:bg-rose-500/20" : "hover:bg-slate-900",
              state.selected && (node.data.isError ? "border-rose-500" : "border-indigo-500")
            )}
            onClick={() => {
              toggleNodeSelection(node.id);
            }}
          >
            <div className="flex h-8 items-center">
              {Array.from({ length: node.level }).map((_, index) => (
                <TaskLine key={index} isError={node.data.isError} isSelected={state.selected} />
              ))}
              <div
                className={cn(
                  "flex h-8 w-4 items-center",
                  node.hasChildren &&
                    (node.data.isError ? "hover:bg-rose-500/30" : "hover:bg-slate-800")
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpandNode(node.id);
                  selectNode(node.id);
                  scrollToNode(node.id);
                }}
                onKeyDown={(e) => {
                  console.log(e.key);
                }}
              >
                {node.hasChildren ? (
                  state.expanded ? (
                    <ChevronDownIcon className="h-4 w-4 text-slate-400" />
                  ) : (
                    <ChevronRightIcon className="h-4 w-4 text-slate-400" />
                  )
                ) : (
                  <div className="h-8 w-4" />
                )}
              </div>
            </div>

            <div className="flex w-full items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-2 overflow-x-hidden">
                <RunIcon name={node.data.style?.icon} className="min-w-4 min-h-4 h-4 w-4" />
                <NodeText node={node} />
              </div>
              <div className="flex items-center gap-2">
                {node.data.isError ? (
                  <div className="flex items-center gap-1">
                    <Paragraph variant="extra-small" className="text-rose-500">
                      Error
                    </Paragraph>
                    <ExclamationCircleIcon className="h-3 w-3 text-rose-500" />
                  </div>
                ) : null}
                {node.data.isPartial ? (
                  <LiveDuration startTime={node.data.startTime} />
                ) : node.data.duration > 0 ? (
                  <Duration duration={node.data.duration} />
                ) : null}
              </div>
            </div>
          </div>
        )}
      />
    </div>
  );
}

function NodeText({ node }: { node: RunEvent }) {
  const className = "truncate";
  return (
    <Paragraph
      variant="small"
      className={cn(className, eventTextClassName(node.data), node.data.isError && "text-rose-500")}
    >
      {node.data.message}
    </Paragraph>
  );
}

function TaskLine({ isError, isSelected }: { isError: boolean; isSelected: boolean }) {
  return (
    <div className={cn("h-8 w-2 border-r", isError ? "border-rose-500/10" : "border-slate-800")} />
  );
}

function Duration({ duration }: { duration: number }) {
  return (
    <Paragraph variant="extra-small" className="whitespace-nowrap">
      {formatDurationNanoseconds(duration, { style: "short" })}
    </Paragraph>
  );
}

function LiveDuration({ startTime }: { startTime: Date }) {
  return (
    <div className="flex items-center gap-1">
      <LiveTimer startTime={startTime} />
      <Spinner color="blue" className="h-4 w-4" />
    </div>
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
        <ShowParentIcon className="h-4 w-4 text-slate-650" />
      )}
      <Paragraph variant="small" className={cn(mouseOver ? "text-indigo-500" : "text-slate-500")}>
        Show parent items
      </Paragraph>
    </Link>
  );
}

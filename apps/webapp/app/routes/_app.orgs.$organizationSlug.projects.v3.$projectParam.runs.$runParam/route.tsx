import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/20/solid";
import { Link, useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { animate, motion, useMotionValue, useTime, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ErrorIcon } from "~/assets/icons/ErrorIcon";
import { ShowParentIcon, ShowParentIconSelected } from "~/assets/icons/ShowParentIcon";
import { PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { PageHeader, PageTitle, PageTitleRow } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import { TreeView, useTree } from "~/components/primitives/TreeView";
import { RunIcon } from "~/components/runs/v3/RunIcon";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunEvent, RunPresenter } from "~/presenters/v3/RunPresenter.server";
import { requireUserId } from "~/services/session.server";
import { formatDuration, formatDurationMilliseconds, formatDurationNanoseconds } from "~/utils";
import { cn } from "~/utils/cn";
import { v3RunParamsSchema, v3RunPath } from "~/utils/pathBuilder";

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

  return typedjson({
    run,
    events,
    parentRunFriendlyId,
  });
};

export default function Page() {
  const { run, events, parentRunFriendlyId } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  return (
    <>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title={`Run #${run.number}`} />
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <div className={cn("grid h-full grid-cols-1 gap-4")}>
          <div className="h-full overflow-y-clip">
            <div className="mb-2 flex items-center justify-between gap-x-2"></div>
            <TasksTreeView
              key={events[0]?.id ?? "-"}
              events={events}
              parentRunFriendlyId={parentRunFriendlyId}
            />
          </div>
        </div>
      </PageBody>
    </>
  );
}

function TasksTreeView({
  events,
  parentRunFriendlyId,
}: {
  events: RunEvent[];
  parentRunFriendlyId?: string;
}) {
  const [filterText, setFilterText] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const {
    nodes,
    selected,
    getTreeProps,
    getNodeProps,
    toggleNodeSelection,
    toggleExpandNode,
    selectNode,
    selectFirstVisibleNode,
    selectLastVisibleNode,
    scrollToNode,
    virtualizer,
  } = useTree({
    tree: events,
    // selectedId,
    // collapsedIds,
    // onStateChanged: changed,
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
    <>
      <div className="flex items-center justify-between gap-2 border-b border-slate-850 py-1">
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
        parentClassName="h-full"
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
              <div className="flex items-center gap-2 ">
                <RunIcon name={node.data.style?.icon} className="h-4 w-4" />
                <Paragraph
                  variant="small/bright"
                  className={cn(node.data.isError && "text-rose-500")}
                >
                  {node.data.message}
                </Paragraph>
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
    </>
  );
}

function TaskLine({ isError, isSelected }: { isError: boolean; isSelected: boolean }) {
  return (
    <div className={cn("h-8 w-2 border-r", isError ? "border-rose-500/10" : "border-slate-800")} />
  );
}

function Duration({ duration }: { duration: number }) {
  return (
    <Paragraph variant="extra-small">
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

function LiveTimer({
  startTime,
  endTime,
  updateInterval = 250,
}: {
  startTime: Date;
  endTime?: Date;
  updateInterval?: number;
}) {
  const [now, setNow] = useState<Date>();

  useEffect(() => {
    const interval = setInterval(() => {
      const date = new Date();
      setNow(date);

      if (endTime && date > endTime) {
        clearInterval(interval);
      }
    }, updateInterval);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <Paragraph variant="extra-small" className="tabular-nums">
      {formatDuration(startTime, now, {
        style: "short",
        maxDecimalPoints: 0,
        units: ["d", "h", "m", "s"],
      })}
    </Paragraph>
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

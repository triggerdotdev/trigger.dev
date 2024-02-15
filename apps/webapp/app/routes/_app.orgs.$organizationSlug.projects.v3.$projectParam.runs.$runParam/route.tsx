import { useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { UseDataFunctionReturn, typedjson, useTypedLoaderData } from "remix-typedjson";
import { RunsFilters, TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListPresenter } from "~/presenters/v3/RunListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3RunParamsSchema } from "~/utils/pathBuilder";
import { ListPagination } from "../../components/ListPagination";
import { list } from "tar";
import { PageBody } from "~/components/layout/AppLayout";
import { PageHeader, PageTitleRow, PageTitle } from "~/components/primitives/PageHeader";
import { RunEvent, RunPresenter } from "~/presenters/v3/RunPresenter.server";
import { useRef } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentIcon,
  InformationCircleIcon,
} from "@heroicons/react/20/solid";
import { FolderOpenIcon, FolderIcon, WandIcon } from "lucide-react";
import { useTree, TreeView } from "~/components/primitives/TreeView";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Icon } from "~/components/primitives/Icon";
import { NamedIcon } from "~/components/primitives/NamedIcon";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, runParam } = v3RunParamsSchema.parse(params);

  const presenter = new RunPresenter();
  const { run, events } = await presenter.call({
    userId,
    organizationSlug,
    projectSlug: projectParam,
    runFriendlyId: runParam,
  });

  return typedjson({
    run,
    events,
  });
};

export default function Page() {
  const { run, events } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const project = useProject();
  const user = useUser();

  return (
    <>
      <PageHeader hideBorder>
        <PageTitleRow>
          <PageTitle title={`Run`} />
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <div className={cn("grid h-fit grid-cols-1 gap-4")}>
          <div>
            <div className="mb-2 flex items-center justify-between gap-x-2"></div>
            <div>
              <TasksTreeView events={events} />
            </div>
          </div>
        </div>
      </PageBody>
    </>
  );
}

function TasksTreeView({ events }: { events: RunEvent[] }) {
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
    // filter: (node) => {
    //   if (filterText === "") return true;
    //   if (node.data.title.toLowerCase().includes(filterText.toLowerCase())) {
    //     return true;
    //   }
    //   return false;
    // },
  });

  return (
    <>
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

            <div className="flex items-center gap-2">
              <TaskIcon name={node.data.style?.icon} />
              <Paragraph
                variant="small/bright"
                className={cn(node.data.isError && "text-rose-500")}
              >
                {node.data.message} {node.data.isError && "Error"}
              </Paragraph>
            </div>
          </div>
        )}
      />
    </>
  );
}

function TaskLine({ isError, isSelected }: { isError: boolean; isSelected: boolean }) {
  return (
    <div className={cn("h-8 w-2 border-r", isError ? "border-rose-500/40" : "border-slate-800")} />
  );
}

function TaskIcon({ name }: { name: string | undefined }) {
  if (!name) return <InformationCircleIcon className="h-4 w-4 text-slate-800" />;

  switch (name) {
    case "task":
      return <DocumentIcon className="h-4 w-4" />;
    case "attempt":
      return <WandIcon className="h-4 w-4" />;
    case "wait":
      return <FolderIcon className="h-4 w-4" />;
  }

  return (
    <NamedIcon
      name={name}
      className="h-4 w-4"
      fallback={<InformationCircleIcon className="h-4 w-4 text-slate-800" />}
    />
  );
}

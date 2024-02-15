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
import { DocumentIcon } from "@heroicons/react/20/solid";
import { FolderOpenIcon, FolderIcon } from "lucide-react";
import { useTree, TreeView } from "~/components/primitives/TreeView";

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
        parentClassName="h-full bg-slate-900"
        renderNode={({ node, state, index, virtualizer, virtualItem }) => (
          <div
            style={{
              paddingLeft: `${node.level * 1}rem`,
            }}
            className={cn(
              "flex cursor-pointer items-center gap-2 py-1 hover:bg-blue-500/10",
              state.selected && "bg-blue-500/20 hover:bg-blue-500/30"
            )}
            onClick={() => {
              toggleNodeSelection(node.id);
            }}
          >
            <div
              className="h-4 w-4"
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
                  <FolderOpenIcon className="h-4 w-4 text-blue-500" />
                ) : (
                  <FolderIcon className="h-4 w-4 text-blue-500/50" />
                )
              ) : (
                <DocumentIcon className="h-4 w-4" />
              )}
            </div>
            <div>{node.data.message}</div>
          </div>
        )}
      />
    </>
  );
}

import { UnmountClosed } from "react-collapse";
import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { Changes, InputTreeState, TreeView, flattenTree, useTree } from "../primitives/TreeView";
import { cn } from "~/utils/cn";
import { DocumentIcon, FolderIcon, FolderOpenIcon } from "@heroicons/react/20/solid";
import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "../primitives/Buttons";
import { Input } from "../primitives/Input";

const meta: Meta = {
  title: "Primitives/TreeView",
  decorators: [withDesign],
};
export default meta;
type Story = StoryObj<typeof TreeViewsSet>;

export const TreeViews: Story = {
  render: () => {
    return <TreeViewsSet />;
  },
};

const data = {
  id: "policies",
  data: {
    title: "Policies",
  },
  children: [
    {
      id: "registration",
      data: {
        title: "Registration",
      },
      children: [
        {
          id: "registration-a",
          data: { title: "Registration A" },
        },
        {
          id: "registration-b",
          data: { title: "Registration B" },
        },
        {
          id: "registration-c",
          data: { title: "Registration C" },
        },
        { id: "registration-d", data: { title: "Registration D" } },
      ],
    },
    {
      id: "authentication",
      data: {
        title: "Authentication",
      },
      children: [
        {
          id: "authentication-a",
          data: { title: "Authentication A" },
          children: [
            {
              id: "double-child-a",
              data: { title: "Double child A" },
            },
            {
              id: "double-child-b",
              data: { title: "Double child B" },
            },
          ],
        },
        {
          id: "authentication-b",
          data: { title: "Authentication B" },
        },
      ],
    },
  ],
};
const tree = flattenTree(data);

function TreeViewsSet() {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [collapsedIds, setCollapsedIds] = useState<string[]>([]);

  return (
    <div className="flex flex-col items-start justify-start gap-4">
      <div className="flex items-center gap-2 p-2">
        <Input
          placeholder="Selected"
          value={selectedId}
          onChange={(v) => setSelectedId(v.target.value)}
        />
        <Input
          placeholder="Collapsed"
          value={collapsedIds}
          onChange={(e) => {
            const val = e.target.value;
            const ids = val.split(",").map((v) => v.trim());
            setCollapsedIds(ids);
          }}
        />
      </div>

      <TreeViewParent selectedId={selectedId} collapsedIds={collapsedIds} />
    </div>
  );
}

function TreeViewParent({
  selectedId,
  collapsedIds,
}: {
  selectedId?: string;
  collapsedIds?: string[];
}) {
  const changed = useCallback((state: Changes) => {
    console.log("changed", state);
  }, []);

  const {
    nodes,
    selected,
    getTreeProps,
    getNodeProps,
    toggleNodeSelection,
    toggleExpandNode,
    selectNode,
    selectFirstVisibleNode,
  } = useTree({
    tree,
    selectedId,
    collapsedIds,
    onStateChanged: changed,
  });

  console.log("selected", selected);
  // console.log("nodes", nodes);

  return (
    <div className="flex flex-col items-start gap-y-4 p-4">
      <div className="flex items-center gap-2">
        <Button variant="secondary/small" onClick={() => selectFirstVisibleNode()}>
          Select first
        </Button>
        <Button variant="secondary/small" onClick={() => selectNode("registration-b")}>
          Select Registration B
        </Button>
      </div>
      <TreeView
        autoFocus
        tree={tree}
        nodes={nodes}
        estimatedRowHeight={({ state }) => (state.visibility === "visible" ? 32 : 0)}
        renderParent={({ children, ref }) => (
          <div
            ref={ref}
            className="h-96 w-full overflow-y-auto bg-slate-900 focus-within:outline-none"
            {...getTreeProps()}
          >
            {children}
          </div>
        )}
        renderNode={({ node, state, index, virtualizer }) => (
          <div
            key={node.id}
            data-index={index}
            ref={virtualizer.measureElement}
            className="[&_.ReactCollapse--collapse]:transition-all "
          >
            <UnmountClosed key={node.id} isOpened={state.visibility === "visible"}>
              <div
                key={node.id}
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
                {...getNodeProps(node.id)}
              >
                <div
                  className="h-4 w-4"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpandNode(node.id);
                    selectNode(node.id);
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
                <div>{node.data.title}</div>
              </div>
            </UnmountClosed>
          </div>
        )}
      />
    </div>
  );
}

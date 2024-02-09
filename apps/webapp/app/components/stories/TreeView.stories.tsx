import type { Meta, StoryObj } from "@storybook/react";
import { withDesign } from "storybook-addon-designs";
import { InputTreeState, TreeView, flattenTree, useTreeState } from "../primitives/TreeView";
import { cn } from "~/utils/cn";
import { DocumentIcon, FolderIcon, FolderOpenIcon } from "@heroicons/react/20/solid";
import { useState } from "react";

const meta: Meta = {
  title: "Primitives/TreeView",
  decorators: [withDesign],
};
export default meta;
type Story = StoryObj<typeof TreeViewsSet>;

export const TreeViews: Story = {
  render: () => {
    return (
      <TreeViewsSet
        defaultState={{
          authentication: { selected: false, expanded: false },
          "registration-b": { selected: true },
        }}
      />
    );
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

function TreeViewsSet({ defaultState }: { defaultState?: InputTreeState }) {
  const { nodes, visibleItemCount, selected, selectNode, deselectNode, toggleNodeSelection } =
    useTreeState({
      tree,
      defaultState,
    });

  console.log(selected, nodes);

  return (
    <div className="grid grid-cols-2">
      <div className="flex flex-col items-start gap-y-4 p-4">
        <TreeView
          tree={tree}
          nodes={nodes}
          visibleItemCount={visibleItemCount}
          estimatedRowHeight={() => 40}
          renderParent={({ children, ref }) => (
            <div ref={ref} className="h-96 w-full overflow-y-auto bg-slate-900">
              {children}
            </div>
          )}
          renderNode={({ node, state }) => (
            <div
              style={{
                paddingLeft: `${node.level * 1}rem`,
              }}
              className={cn(
                "flex cursor-pointer items-center gap-2 py-1 hover:bg-blue-500/10",
                state.visibility === "hidden" && "hidden",
                state.selected && "bg-blue-500/20 hover:bg-blue-500/30"
              )}
              onClick={() => {
                toggleNodeSelection(node.id);
              }}
            >
              <div className="h-4 w-4">
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
          )}
        />
      </div>
    </div>
  );
}

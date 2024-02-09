import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, RefObject, useRef } from "react";

export type TreeViewProps<TData> = {
  tree: FlatTree<TData>;
  renderParent: (params: { children: React.ReactNode; ref: RefObject<any> }) => JSX.Element;
  estimatedRowHeight: (index: number) => number;
  renderNode: (params: {
    node: FlatTreeItem<TData>;
    state: NodeState & { visibility: NodeVisibility };
  }) => React.ReactNode;
  state: TreeState;
};

export function TreeView<TData>({
  tree,
  renderParent,
  renderNode,
  state,
  estimatedRowHeight,
}: TreeViewProps<TData>) {
  //todo change renderer to use TanStack virtualizer
  const parentRef = useRef<HTMLElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: state.visibleItemCount,
    getScrollElement: () => parentRef.current,
    estimateSize: estimatedRowHeight,
  });

  return renderParent({
    ref: parentRef,
    children: (
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualItem) => {
          const node = tree[virtualItem.index];
          return (
            <Fragment key={node.id}>
              {renderNode({
                node,
                state: state.nodes[node.id],
              })}
            </Fragment>
          );
        })}
      </div>
    ),
  });
}

type NodeState = {
  selected: boolean;
  expanded: boolean;
};

type NodeVisibility = "visible" | "hidden";

type InputNodeStates = Record<string, Partial<NodeState>>;

type TreeStateHookProps = {
  tree: FlatTree<any>;
  defaultState?: InputNodeStates;
  onNodeStateChange?: (
    nodeId: string,
    state: { state: NodeState; visibility: NodeVisibility }
  ) => void;
  selectNode?: (id: string) => void;
  selectNextVisibleNode?: () => void;
  selectPreviousVisibleNode?: () => void;
  expandNode?: (id: string) => void;
  collapseNode?: (id: string) => void;
};

type TreeState = {
  selected: string | undefined;
  nodes: Record<
    string,
    NodeState & {
      visibility: NodeVisibility;
    }
  >;
  visibleItemCount: number;
};

export function useTreeState({ tree, defaultState }: TreeStateHookProps): TreeState {
  if (!defaultState) {
    defaultState = {} as InputNodeStates;
  }

  //for each defaultState, explicitly set the selected and expanded state if they're undefined
  const concreteState = tree.reduce((acc, node) => {
    acc[node.id] = {
      selected: acc[node.id]?.selected ?? false,
      expanded: acc[node.id]?.expanded ?? true,
    };
    return acc;
  }, defaultState as Record<string, NodeState>);

  const stateEntries = Object.entries(concreteState);
  const selected = stateEntries.find(([id, state]) => state.selected)?.[0];

  //create the state and visibility for each Node
  //Nodes where the parent is collapsed are hidden, and can't be selected
  let visibleItemCount = 0;
  const nodes = tree.reduce((acc, node) => {
    //groups are open by default
    const state = concreteState![node.id] ?? {
      selected: false,
      expanded: node.hasChildren ? true : false,
    };
    const parent = node.parentId
      ? acc[node.parentId]
      : { selected: false, expanded: true, visibility: "visible" };
    const visibility = parent.expanded && parent.visibility === "visible" ? "visible" : "hidden";
    acc[node.id] = { ...state, visibility };

    if (visibility === "visible") {
      visibleItemCount++;
    }

    return acc;
  }, {} as Record<string, NodeState & { visibility: NodeVisibility }>);

  return {
    selected,
    nodes,
    visibleItemCount,
  };
}

/** An actual tree structure with custom data */
export type Tree<TData> = {
  id: string;
  children?: Tree<TData>[];
  data: TData;
};

/** A tree but flattened so it can easily be used for DOM elements */
export type FlatTreeItem<TData> = {
  id: string;
  parentId: string | undefined;
  children: string[];
  hasChildren: boolean;
  /** The indentation level, the root is 0 */
  level: number;
  data: TData;
};

export type FlatTree<TData> = FlatTreeItem<TData>[];

export function flattenTree<TData>(tree: Tree<TData>): FlatTree<TData> {
  const flatTree: FlatTree<TData> = [];

  function flattenNode(node: Tree<TData>, parentId: string | undefined, level: number) {
    const children = node.children?.map((child) => child.id) ?? [];
    flatTree.push({
      id: node.id,
      parentId,
      children,
      hasChildren: children.length > 0,
      level,
      data: node.data,
    });

    node.children?.forEach((child) => {
      flattenNode(child, node.id, level + 1);
    });
  }

  flattenNode(tree, undefined, 0);

  return flatTree;
}

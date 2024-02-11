import { VirtualItem, Virtualizer, useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, RefObject, useCallback, useEffect, useRef, useState } from "react";
import { UnmountClosed } from "react-collapse";
import { cn } from "~/utils/cn";

export type TreeViewProps<TData> = {
  tree: FlatTree<TData>;
  parentClassName?: string;

  renderNode: (params: {
    node: FlatTreeItem<TData>;
    state: NodeState & { visibility: NodeVisibility };
    index: number;
    virtualizer: Virtualizer<HTMLElement, Element>;
    virtualItem: VirtualItem;
  }) => React.ReactNode;
  nodes: TreeState["nodes"];
  autoFocus?: boolean;
  virtualizer: Virtualizer<HTMLElement, Element>;
  parentRef: RefObject<any>;
} & Pick<TreeState, "getTreeProps" | "getNodeProps">;

export function TreeView<TData>({
  tree,
  renderNode,
  nodes,
  autoFocus = false,
  getTreeProps,
  getNodeProps,
  parentClassName,
  virtualizer,
  parentRef,
}: TreeViewProps<TData>) {
  useEffect(() => {
    if (autoFocus) {
      parentRef.current?.focus();
    }
  }, [autoFocus, parentRef]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      className={cn("w-full overflow-y-auto focus-within:outline-none", parentClassName)}
      {...getTreeProps()}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${virtualItems.at(0)?.start ?? 0}px)`,
          }}
        >
          {virtualItems.map((virtualItem) => {
            const node = tree.find((node) => node.id === virtualItem.key)!;
            return (
              <div
                key={node.id}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="[&_.ReactCollapse--collapse]:transition-all"
                {...getNodeProps(node.id)}
              >
                <UnmountClosed key={node.id} isOpened={nodes[node.id].visibility === "visible"}>
                  {renderNode({
                    node,
                    state: nodes[node.id],
                    index: virtualItem.index,
                    virtualizer: virtualizer,
                    virtualItem,
                  })}
                </UnmountClosed>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type NodeState = {
  selected: boolean;
  expanded: boolean;
};

type NodeVisibility = "visible" | "hidden";

export type InputTreeState = Record<string, Partial<NodeState>>;

type TreeStateHookProps<TData> = {
  tree: FlatTree<any>;
  selectedId?: string;
  collapsedIds?: string[];
  onStateChanged?: (newState: Changes) => void;
  estimatedRowHeight: (params: {
    node: FlatTreeItem<TData>;
    state: NodeState & { visibility: NodeVisibility };
    index: number;
  }) => number;
  parentRef: RefObject<any>;
};

//this is so Framer Motion can be used to render the components
type HTMLAttributes = Omit<
  React.HTMLAttributes<HTMLElement>,
  "onAnimationStart" | "onDragStart" | "onDragEnd" | "onDrag"
>;

type TreeState = {
  selected: string | undefined;
  nodes: Record<
    string,
    NodeState & {
      visibility: NodeVisibility;
    }
  >;
  virtualizer: Virtualizer<HTMLElement, Element>;

  getTreeProps: () => HTMLAttributes;
  getNodeProps: (id: string) => HTMLAttributes;
  selectNode: (id: string, scrollToNode?: boolean) => void;
  deselectNode: (id: string) => void;
  deselectAllNodes: () => void;
  toggleNodeSelection: (id: string, scrollToNode?: boolean) => void;
  expandNode: (id: string, scrollToNode?: boolean) => void;
  collapseNode: (id: string) => void;
  toggleExpandNode: (id: string, scrollToNode?: boolean) => void;
  selectFirstVisibleNode: (scrollToNode?: boolean) => void;
  selectLastVisibleNode: (scrollToNode?: boolean) => void;
  selectNextVisibleNode: (scrollToNode?: boolean) => void;
  selectPreviousVisibleNode: (scrollToNode?: boolean) => void;
  selectParentNode: (scrollToNode?: boolean) => void;
  scrollToNode: (id: string) => void;
};

type ModifyState = ((state: InputTreeState) => InputTreeState) | InputTreeState;

const defaultSelected = false;
const defaultExpanded = true;

function inputTreeStateFrom({
  tree,
  selectedId,
  collapsedIds,
}: {
  tree: FlatTree<any>;
  selectedId: string | undefined;
  collapsedIds: string[] | undefined;
}): InputTreeState {
  const state: InputTreeState = {};
  collapsedIds?.forEach((id) => {
    const hasTreeItem = tree.some((item) => item.id === id);
    if (hasTreeItem) {
      state[id] = { expanded: false };
    }
  });
  if (selectedId) {
    const selectedNode = tree.find((node) => node.id === selectedId);
    if (selectedNode) {
      state[selectedId] = { selected: true };
      //make sure all parents are expanded
      let parentId = selectedNode.parentId;
      while (parentId) {
        state[parentId] = { expanded: true };
        const parent = tree.find((node) => node.id === parentId);
        parentId = parent?.parentId;
      }
    }
  }
  return state;
}

export function useTree<TData>({
  tree,
  selectedId,
  collapsedIds,
  onStateChanged,
  parentRef,
  estimatedRowHeight,
}: TreeStateHookProps<TData>): TreeState {
  const [state, setState] = useState<InputTreeState>(
    inputTreeStateFrom({ tree, selectedId, collapsedIds })
  );

  const modifyState = useCallback(
    (input: ModifyState) => {
      if (typeof input === "function") {
        setState((state) => {
          const updatedState = input(state);
          onStateChanged?.(generateChanges(updatedState));
          return updatedState;
        });
        return;
      }

      setState(input);
      onStateChanged?.(generateChanges(input));
    },
    [state]
  );

  //if the defaultState changes, update the state
  useEffect(() => {
    modifyState(inputTreeStateFrom({ tree, selectedId, collapsedIds }));
  }, [selectedId, collapsedIds, tree]);

  //for each defaultState, explicitly set the selected and expanded state if they're undefined
  const concreteState = tree.reduce((acc, node) => {
    acc[node.id] = {
      selected: acc[node.id]?.selected ?? defaultSelected,
      expanded: acc[node.id]?.expanded ?? defaultExpanded,
    };
    return acc;
  }, state as Record<string, NodeState>);

  const stateEntries = Object.entries(concreteState);
  const selected = stateEntries.find(([id, state]) => state.selected)?.[0];

  //create the state and visibility for each Node
  //Nodes where the parent is collapsed are hidden, and can't be selected
  const nodes = tree.reduce((acc, node) => {
    //groups are open by default
    const state = concreteState![node.id] ?? {
      selected: defaultSelected,
      expanded: node.hasChildren ? defaultExpanded : !defaultExpanded,
    };
    const parent = node.parentId
      ? acc[node.parentId]
      : { selected: defaultSelected, expanded: defaultExpanded, visibility: "visible" };
    const visibility = parent.expanded && parent.visibility === "visible" ? "visible" : "hidden";
    acc[node.id] = { ...state, visibility };

    return acc;
  }, {} as Record<string, NodeState & { visibility: NodeVisibility }>);

  const virtualizer = useVirtualizer({
    count: tree.length,
    getItemKey: (index) => tree[index].id,
    getScrollElement: () => parentRef.current,
    estimateSize: (index: number) => {
      return estimatedRowHeight({
        node: tree[index],
        state: nodes[tree[index].id],
        index,
      });
    },
  });

  const scrollToNodeFn = useCallback(
    (id: string) => {
      const itemIndex = tree.findIndex((node) => node.id === id);

      if (itemIndex !== -1) {
        virtualizer.scrollToIndex(itemIndex, { align: "auto" });
      }
    },
    [state]
  );

  const selectNode = useCallback(
    (id: string, scrollToNode = true) => {
      //if the node was already selected, do nothing. The user needs to use deselectNode to deselect
      const alreadySelected = state[id]?.selected ?? false;
      if (alreadySelected) {
        return;
      }

      modifyState((state) => {
        const newState = Object.fromEntries(
          Object.entries(state).map(([key, value]) => [key, { ...value, selected: false }])
        );
        newState[id] = { ...newState[id], selected: true };

        if (scrollToNode) {
          scrollToNodeFn(id);
        }

        return newState;
      });
    },
    [state]
  );

  const deselectNode = useCallback(
    (id: string) => {
      modifyState((state) => ({
        ...state,
        [id]: { ...state[id], selected: false },
      }));
    },
    [state]
  );

  const deselectAllNodes = useCallback(() => {
    modifyState((state) =>
      Object.fromEntries(
        Object.entries(state).map(([key, value]) => [key, { ...value, selected: false }])
      )
    );
  }, [state]);

  const toggleNodeSelection = useCallback(
    (id: string, scrollToNode = true) => {
      const currentlySelected = state[id]?.selected ?? false;
      if (currentlySelected) {
        deselectNode(id);
      } else {
        selectNode(id, scrollToNode);
      }
    },
    [state]
  );

  const expandNode = useCallback(
    (id: string, scrollToNode = true) => {
      modifyState((state) => ({
        ...state,
        [id]: { ...state[id], expanded: true },
      }));

      if (scrollToNode) {
        scrollToNodeFn(id);
      }
    },
    [state]
  );

  const collapseNode = useCallback(
    (id: string) => {
      modifyState((state) => ({
        ...state,
        [id]: { ...state[id], expanded: false },
      }));
    },
    [state]
  );

  const toggleExpandNode = useCallback(
    (id: string, scrollToNode = true) => {
      const currentlyExpanded = state[id]?.expanded ?? false;
      if (currentlyExpanded) {
        collapseNode(id);
      } else {
        expandNode(id, scrollToNode);
      }
    },
    [state]
  );

  const selectFirstVisibleNode = useCallback(
    (scrollToNode = true) => {
      const node = firstVisibleNode(tree, nodes);
      if (node) {
        selectNode(node.id, scrollToNode);
      }
    },
    [tree, state]
  );

  const selectLastVisibleNode = useCallback(
    (scrollToNode = true) => {
      const node = lastVisibleNode(tree, nodes);
      if (node) {
        selectNode(node.id, scrollToNode);
      }
    },
    [tree, state]
  );

  const selectNextVisibleNode = useCallback(
    (scrollToNode = true) => {
      if (!selected) {
        selectFirstVisibleNode(scrollToNode);
        return;
      }

      const visible = visibleNodes(tree, nodes);
      const selectedIndex = visible.findIndex((node) => node.id === selected);
      const nextNode = visible[selectedIndex + 1];
      if (nextNode) {
        selectNode(nextNode.id, scrollToNode);
      }
    },
    [selected, state]
  );

  const selectPreviousVisibleNode = useCallback(
    (scrollToNode = true) => {
      if (!selected) {
        selectFirstVisibleNode(scrollToNode);
        return;
      }

      const visible = visibleNodes(tree, nodes);
      const selectedIndex = visible.findIndex((node) => node.id === selected);
      const previousNode = visible[selectedIndex - 1];
      if (previousNode) {
        selectNode(previousNode.id, scrollToNode);
      }
    },
    [selected, state]
  );

  const selectParentNode = useCallback(
    (scrollToNode = true) => {
      if (!selected) {
        selectFirstVisibleNode(scrollToNode);
        return;
      }

      const selectedNode = tree.find((node) => node.id === selected);
      if (!selectedNode) {
        return;
      }

      const parentNode = tree.find((node) => node.id === selectedNode.parentId);
      if (parentNode) {
        selectNode(parentNode.id, scrollToNode);
      }
    },
    [selected, state]
  );

  const getTreeProps = useCallback(() => {
    return {
      role: "tree",
      "aria-multiselectable": true,
      tabIndex: -1,
      onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
        if (e.defaultPrevented) {
          return; // Do nothing if the event was already processed
        }

        switch (e.key) {
          case "Home": {
            selectFirstVisibleNode(true);
            e.preventDefault();
            break;
          }
          case "End": {
            selectLastVisibleNode(true);
            e.preventDefault();
            break;
          }
          case "Down":
          case "ArrowDown": {
            selectNextVisibleNode(true);
            e.preventDefault();
            break;
          }
          case "Up":
          case "ArrowUp": {
            selectPreviousVisibleNode(true);
            e.preventDefault();
            break;
          }
          case "Left":
          case "ArrowLeft": {
            if (selected) {
              const treeNode = tree.find((node) => node.id === selected);
              if (treeNode && treeNode.hasChildren && nodes[selected].expanded) {
                collapseNode(selected);
              } else {
                selectParentNode(true);
              }
            }
            e.preventDefault();
            break;
          }
          case "Right":
          case "ArrowRight": {
            if (selected) {
              expandNode(selected, true);
            }
            e.preventDefault();
            break;
          }
          case "Escape": {
            deselectAllNodes();
            e.preventDefault();
            break;
          }
        }
      },
    };
  }, [selected, state]);

  const getNodeProps = useCallback(
    (id: string) => {
      const node = nodes[id];
      const treeItemIndex = tree.findIndex((node) => node.id === id);
      const treeItem = tree[treeItemIndex];
      return {
        "aria-expanded": node.expanded,
        "aria-level": treeItem.level + 1,
        role: "treeitem",
        tabIndex: node.selected ? -1 : undefined,
      };
    },
    [state]
  );

  return {
    selected,
    nodes,
    getTreeProps,
    getNodeProps,
    selectNode,
    deselectNode,
    deselectAllNodes,
    toggleNodeSelection,
    expandNode,
    collapseNode,
    toggleExpandNode,
    selectFirstVisibleNode,
    selectLastVisibleNode,
    selectNextVisibleNode,
    selectPreviousVisibleNode,
    selectParentNode,
    scrollToNode: scrollToNodeFn,
    virtualizer,
  };
}

function visibleNodes(tree: FlatTree<any>, nodes: TreeState["nodes"]) {
  return tree.filter((node) => nodes[node.id].visibility === "visible");
}

function generateChanges(input: InputTreeState): Changes {
  //if selected === defaultSelected, remove it
  //if expanded === defaultExpanded, remove it
  //if both are default, remove the node
  const selectedId = Object.entries(input).find(([_, state]) => state.selected === true)?.[0];
  const collapsedIds = Object.entries(input)
    .filter(([_, state]) => state.expanded === false)
    .map(([id]) => id);

  return {
    selectedId,
    collapsedIds,
  };
}

function firstVisibleNode(tree: FlatTree<any>, nodes: TreeState["nodes"]) {
  return tree.find((node) => nodes[node.id].visibility === "visible");
}

function lastVisibleNode(tree: FlatTree<any>, nodes: TreeState["nodes"]) {
  return tree
    .slice()
    .reverse()
    .find((node) => nodes[node.id].visibility === "visible");
}

export type Changes = {
  selectedId: string | undefined;
  collapsedIds: string[];
};

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

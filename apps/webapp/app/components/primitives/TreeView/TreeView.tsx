import { VirtualItem, Virtualizer, useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import { MutableRefObject, RefObject, useCallback, useEffect, useReducer, useRef } from "react";
import { cn } from "~/utils/cn";
import { NodeState, NodesState, reducer } from "./reducer";
import { concreteStateFromInput, selectedIdFromState } from "./utils";

export type TreeViewProps<TData> = {
  tree: FlatTree<TData>;
  parentClassName?: string;
  renderNode: (params: {
    node: FlatTreeItem<TData>;
    state: NodeState;
    index: number;
    virtualizer: Virtualizer<HTMLElement, Element>;
    virtualItem: VirtualItem;
  }) => React.ReactNode;
  nodes: UseTreeStateOutput["nodes"];
  autoFocus?: boolean;
  virtualizer: Virtualizer<HTMLElement, Element>;
  parentRef?: MutableRefObject<HTMLElement | null>;
  scrollRef?: MutableRefObject<HTMLElement | null>;
  onScroll?: (scrollTop: number) => void;
} & Pick<UseTreeStateOutput, "getTreeProps" | "getNodeProps">;

export type GetTreePropsFn = UseTreeStateOutput["getTreeProps"];
export type GetNodePropsFn = UseTreeStateOutput["getNodeProps"];

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
  scrollRef,
  onScroll,
}: TreeViewProps<TData>) {
  useEffect(() => {
    if (autoFocus) {
      parentRef?.current?.focus();
    }
  }, [autoFocus, parentRef?.current]);

  const virtualItems = virtualizer.getVirtualItems();

  const scrollCallback = useCallback(
    (event: Event) => {
      if (!onScroll) return;
      const target = event.target as HTMLElement;
      onScroll?.(target.scrollTop);
    },
    [onScroll]
  );

  useEffect(() => {
    //subscribe to scrollRef scroll event
    if (!scrollRef?.current || onScroll === undefined) return;
    scrollRef.current.addEventListener("scroll", scrollCallback);
    return () => scrollRef.current?.removeEventListener("scroll", scrollCallback);
  }, [scrollRef?.current]);

  return (
    <motion.div
      ref={(element) => {
        if (parentRef) {
          parentRef.current = element;
        }
        if (scrollRef) {
          scrollRef.current = element;
        }
      }}
      className={cn(
        "w-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 focus-within:outline-none",
        parentClassName
      )}
      layoutScroll
      {...getTreeProps()}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
          overflowY: "visible",
        }}
      >
        <div
          style={{
            position: "absolute",
            overflowY: "visible",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${virtualItems.at(0)?.start ?? 0}px)`,
          }}
        >
          {virtualItems.map((virtualItem) => {
            const node = tree.find((node) => node.id === virtualItem.key);
            if (!node) return null;
            const state = nodes[node.id];
            if (!state) return null;
            if (!state.visible) return null;
            return (
              <div
                key={node.id}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                className="overflow-clip"
                {...getNodeProps(node.id)}
              >
                {renderNode({
                  node,
                  state,
                  index: virtualItem.index,
                  virtualizer: virtualizer,
                  virtualItem,
                })}
              </div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}

export type Filter<TData, TFilterValue> = {
  value?: TFilterValue;
  fn: (value: TFilterValue, node: FlatTreeItem<TData>) => boolean;
};

type TreeStateHookProps<TData, TFilterValue> = {
  tree: FlatTree<TData>;
  selectedId?: string;
  collapsedIds?: string[];
  onSelectedIdChanged?: (selectedId: string | undefined) => void;
  estimatedRowHeight: (params: {
    node: FlatTreeItem<TData>;
    state: NodeState;
    index: number;
  }) => number;
  parentRef: RefObject<any>;
  filter?: Filter<TData, TFilterValue>;
};

//this is so Framer Motion can be used to render the components
type HTMLAttributes = Omit<
  React.HTMLAttributes<HTMLElement>,
  "onAnimationStart" | "onDragStart" | "onDragEnd" | "onDrag"
>;

export type UseTreeStateOutput = {
  selected: string | undefined;
  nodes: NodesState;
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
  expandAllBelowDepth: (depth: number) => void;
  collapseAllBelowDepth: (depth: number) => void;
  expandLevel: (level: number) => void;
  collapseLevel: (level: number) => void;
  toggleExpandLevel: (level: number) => void;
  selectFirstVisibleNode: (scrollToNode?: boolean) => void;
  selectLastVisibleNode: (scrollToNode?: boolean) => void;
  selectNextVisibleNode: (scrollToNode?: boolean) => void;
  selectPreviousVisibleNode: (scrollToNode?: boolean) => void;
  selectParentNode: (scrollToNode?: boolean) => void;
  scrollToNode: (id: string) => void;
};

export function useTree<TData, TFilterValue>({
  tree,
  selectedId,
  collapsedIds,
  onSelectedIdChanged,
  parentRef,
  estimatedRowHeight,
  filter,
}: TreeStateHookProps<TData, TFilterValue>): UseTreeStateOutput {
  const previousNodeCount = useRef(tree.length);
  const previousSelectedId = useRef<string | undefined>(selectedId);

  const [state, dispatch] = useReducer(
    reducer,
    concreteStateFromInput({ tree, selectedId, collapsedIds, filter })
  );

  //fire onSelectedIdChanged()
  useEffect(() => {
    const selectedId = selectedIdFromState(state.nodes);
    if (selectedId !== previousSelectedId.current) {
      previousSelectedId.current = selectedId;
      onSelectedIdChanged?.(selectedId);
    }
  }, [state.changes.selectedId]);

  //update tree when the number of nodes changes
  useEffect(() => {
    if (tree.length !== previousNodeCount.current) {
      previousNodeCount.current = tree.length;
      dispatch({ type: "UPDATE_TREE", payload: { tree } });
    }
  }, [previousNodeCount.current, tree.length]);

  //update the filter, if it's changed
  const previousFilter = useRef(filter);
  useEffect(() => {
    //check if the value (not reference) of the filter is the same
    const previousValue = previousFilter.current
      ? JSON.stringify(previousFilter.current.value)
      : undefined;
    const newValue = filter ? JSON.stringify(filter.value) : undefined;

    previousFilter.current = filter;

    if (previousValue !== newValue) {
      dispatch({ type: "UPDATE_FILTER", payload: { filter } });
    }
  }, [filter?.value]);

  const virtualizer = useVirtualizer({
    count: state.visibleNodeIds.length,
    getItemKey: (index) => state.visibleNodeIds[index],
    getScrollElement: () => parentRef.current,
    estimateSize: (index: number) => {
      const treeItem = tree[index];
      if (!treeItem) return 0;
      return estimatedRowHeight({
        node: treeItem,
        state: state.nodes[treeItem.id],
        index,
      });
    },
    overscan: 50,
  });

  const scrollToNodeFn = useCallback(
    (id: string) => {
      const itemIndex = state.visibleNodeIds.findIndex((n) => n === id);

      if (itemIndex !== -1) {
        virtualizer.scrollToIndex(itemIndex, { align: "auto" });
      }
    },
    [state]
  );

  const selectNode = useCallback(
    (id: string, scrollToNode = true) => {
      dispatch({ type: "SELECT_NODE", payload: { id, scrollToNode, scrollToNodeFn } });
    },
    [state]
  );

  const deselectNode = useCallback(
    (id: string) => {
      dispatch({ type: "DESELECT_NODE", payload: { id } });
    },
    [state]
  );

  const deselectAllNodes = useCallback(() => {
    dispatch({ type: "DESELECT_ALL_NODES" });
  }, [state]);

  const toggleNodeSelection = useCallback(
    (id: string, scrollToNode = true) => {
      dispatch({ type: "TOGGLE_NODE_SELECTION", payload: { id, scrollToNode, scrollToNodeFn } });
    },
    [state]
  );

  const expandNode = useCallback(
    (id: string, scrollToNode = true) => {
      dispatch({ type: "EXPAND_NODE", payload: { id, scrollToNode, scrollToNodeFn } });
    },
    [state]
  );

  const collapseNode = useCallback(
    (id: string) => {
      dispatch({ type: "COLLAPSE_NODE", payload: { id } });
    },
    [state]
  );

  const toggleExpandNode = useCallback(
    (id: string, scrollToNode = true) => {
      dispatch({ type: "TOGGLE_EXPAND_NODE", payload: { id, scrollToNode, scrollToNodeFn } });
    },
    [state]
  );

  const selectFirstVisibleNode = useCallback(
    (scrollToNode = true) => {
      dispatch({
        type: "SELECT_FIRST_VISIBLE_NODE",
        payload: { scrollToNode, scrollToNodeFn },
      });
    },
    [tree, state]
  );

  const selectLastVisibleNode = useCallback(
    (scrollToNode = true) => {
      dispatch({
        type: "SELECT_LAST_VISIBLE_NODE",
        payload: { scrollToNode, scrollToNodeFn },
      });
    },
    [tree, state]
  );

  const selectNextVisibleNode = useCallback(
    (scrollToNode = true) => {
      dispatch({
        type: "SELECT_NEXT_VISIBLE_NODE",
        payload: { scrollToNode, scrollToNodeFn },
      });
    },
    [state]
  );

  const selectPreviousVisibleNode = useCallback(
    (scrollToNode = true) => {
      dispatch({
        type: "SELECT_PREVIOUS_VISIBLE_NODE",
        payload: { scrollToNode, scrollToNodeFn },
      });
    },
    [state]
  );

  const selectParentNode = useCallback(
    (scrollToNode = true) => {
      dispatch({
        type: "SELECT_PARENT_NODE",
        payload: { scrollToNode, scrollToNodeFn },
      });
    },
    [state]
  );

  const expandAllBelowDepth = useCallback(
    (depth: number) => {
      dispatch({ type: "EXPAND_ALL_BELOW_DEPTH", payload: { depth } });
    },
    [state]
  );

  const collapseAllBelowDepth = useCallback(
    (depth: number) => {
      dispatch({ type: "COLLAPSE_ALL_BELOW_DEPTH", payload: { depth } });
    },
    [state]
  );

  const expandLevel = useCallback(
    (level: number) => {
      dispatch({ type: "EXPAND_LEVEL", payload: { level } });
    },
    [state]
  );

  const collapseLevel = useCallback(
    (level: number) => {
      dispatch({ type: "COLLAPSE_LEVEL", payload: { level } });
    },
    [state]
  );

  const toggleExpandLevel = useCallback(
    (level: number) => {
      dispatch({ type: "TOGGLE_EXPAND_LEVEL", payload: { level } });
    },
    [state]
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
            if (e.metaKey) {
              return;
            }

            e.preventDefault();

            const selected = selectedIdFromState(state.nodes);
            if (selected) {
              const treeNode = tree.find((node) => node.id === selected);

              if (e.altKey) {
                if (treeNode && treeNode.hasChildren) {
                  collapseLevel(treeNode.level);
                }
                break;
              }

              const shouldCollapse =
                treeNode && treeNode.hasChildren && state.nodes[selected].expanded;
              if (shouldCollapse) {
                collapseNode(selected);
              } else {
                selectParentNode(true);
              }
            }

            break;
          }
          case "Right":
          case "ArrowRight": {
            e.preventDefault();

            const selected = selectedIdFromState(state.nodes);

            if (selected) {
              const treeNode = tree.find((node) => node.id === selected);

              if (e.altKey) {
                if (treeNode && treeNode.hasChildren) {
                  expandLevel(treeNode.level);
                }
                break;
              }

              expandNode(selected, true);
            }
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
  }, [state]);

  const getNodeProps = useCallback(
    (id: string) => {
      const node = state.nodes[id];
      if (!node) return {};
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
    selected: selectedIdFromState(state.nodes),
    nodes: state.nodes,
    getTreeProps,
    getNodeProps,
    selectNode,
    deselectNode,
    deselectAllNodes,
    toggleNodeSelection,
    expandNode,
    collapseNode,
    toggleExpandNode,
    expandAllBelowDepth,
    collapseAllBelowDepth,
    expandLevel,
    collapseLevel,
    toggleExpandLevel,
    selectFirstVisibleNode,
    selectLastVisibleNode,
    selectNextVisibleNode,
    selectPreviousVisibleNode,
    selectParentNode,
    scrollToNode: scrollToNodeFn,
    virtualizer,
  };
}

/** An actual tree structure with custom data */
export type Tree<TData> = {
  id: string;
  runId?: string;
  children?: Tree<TData>[];
  data: TData;
};

/** A tree but flattened so it can easily be used for DOM elements */
export type FlatTreeItem<TData> = {
  id: string;
  parentId?: string | undefined;
  runId?: string;
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
      runId: node.runId,
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

type FlatTreeWithoutChildren<TData> = {
  id: string;
  parentId: string | undefined;
  runId?: string;
  data: TData;
};

export function createTreeFromFlatItems<TData>(
  withoutChildren: FlatTreeWithoutChildren<TData>[],
  rootId: string
): Tree<TData> | undefined {
  // Index items by id
  const indexedItems: { [id: string]: Tree<TData> } = withoutChildren.reduce((acc, item) => {
    acc[item.id] = { id: item.id, runId: item.runId, data: item.data, children: [] };
    return acc;
  }, {} as { [id: string]: Tree<TData> });

  // Add items to parent's children array
  withoutChildren.forEach((item) => {
    const indexedItem = indexedItems[item.id];
    if (item.parentId !== undefined) {
      const parentItem = indexedItems[item.parentId];
      if (parentItem) {
        // If parent ID doesn't exist, this is also a root item
        parentItem.children?.push(indexedItem);
      }
    }
  });

  return indexedItems[rootId];
}

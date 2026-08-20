import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import type { MutableRefObject, RefObject } from "react";
import { useEffect, useMemo, useReducer, useRef } from "react";
import { cn } from "~/utils/cn";
import type { NodeState, NodesState } from "./reducer";
import { reducer } from "./reducer";
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
  }, [autoFocus, parentRef]);

  const virtualItems = virtualizer.getVirtualItems();

  // id -> node lookup so each virtual row resolves in O(1) instead of
  // scanning the whole tree per row.
  const nodesById = useMemo(() => {
    const map = new Map<string, FlatTreeItem<TData>>();
    for (const node of tree) {
      map.set(node.id, node);
    }
    return map;
  }, [tree]);

  const onScrollRef = useRef(onScroll);
  useEffect(() => {
    onScrollRef.current = onScroll;
  }, [onScroll]);

  const hasOnScroll = onScroll !== undefined;
  useEffect(() => {
    const scrollElement = scrollRef?.current;
    if (!scrollElement || !hasOnScroll) return;

    const handleScroll = (event: Event) => {
      const target = event.target as HTMLElement;
      onScrollRef.current?.(target.scrollTop);
    };

    scrollElement.addEventListener("scroll", handleScroll);
    return () => scrollElement.removeEventListener("scroll", handleScroll);
  }, [hasOnScroll, scrollRef]);

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
        "w-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control focus-within:outline-hidden",
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
            const node = nodesById.get(virtualItem.key as string);
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

// oxlint-disable-next-line react/react-compiler -- TanStack Virtual is not compatible with compiler memoization.
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
  const previousExternalSelectedId = useRef(selectedId);
  const onSelectedIdChangedRef = useRef(onSelectedIdChanged);
  const latestTreeRef = useRef(tree);
  latestTreeRef.current = tree;

  const [state, dispatch] = useReducer(
    reducer,
    concreteStateFromInput({ tree, selectedId, collapsedIds, filter })
  );
  const currentSelectedId = selectedIdFromState(state.nodes);

  // id -> index lookup so getNodeProps resolves in O(1) instead of scanning
  // the whole tree per rendered row.
  const treeIndexById = useMemo(() => {
    const map = new Map<string, number>();
    tree.forEach((node, index) => {
      map.set(node.id, index);
    });
    return map;
  }, [tree]);

  // Sync external selectedId changes into internal state without turning the prop into
  // a fully controlled value that immediately overrides internal keyboard selection.
  useEffect(() => {
    if (selectedId === previousExternalSelectedId.current) return;
    previousExternalSelectedId.current = selectedId;

    if (selectedId === undefined) {
      dispatch({ type: "DESELECT_ALL_NODES" });
    } else {
      dispatch({
        type: "SELECT_NODE",
        payload: { id: selectedId, scrollToNode: false, scrollToNodeFn: () => {} },
      });
    }
  }, [selectedId]);

  useEffect(() => {
    onSelectedIdChangedRef.current = onSelectedIdChanged;
  }, [onSelectedIdChanged]);

  // Fire onSelectedIdChanged() only when selection changes, not when the callback is recreated.
  useEffect(() => {
    if (currentSelectedId !== previousSelectedId.current) {
      previousSelectedId.current = currentSelectedId;
      onSelectedIdChangedRef.current?.(currentSelectedId);
    }
  }, [currentSelectedId]);

  const treeNodeCount = tree.length;

  // Callers may recreate the tree array; preserve reducer state unless its shape changes.
  useEffect(() => {
    if (treeNodeCount !== previousNodeCount.current) {
      previousNodeCount.current = treeNodeCount;
      dispatch({ type: "UPDATE_TREE", payload: { tree: latestTreeRef.current } });
    }
  }, [treeNodeCount]);

  const latestFilterRef = useRef(filter);
  latestFilterRef.current = filter;
  const serializedFilterValue = filter ? JSON.stringify(filter.value) : undefined;
  const previousSerializedFilterValue = useRef(serializedFilterValue);

  // Filter behavior is keyed by value; callers may recreate the filter function every render.
  useEffect(() => {
    if (serializedFilterValue === previousSerializedFilterValue.current) return;

    previousSerializedFilterValue.current = serializedFilterValue;
    dispatch({ type: "UPDATE_FILTER", payload: { filter: latestFilterRef.current } });
  }, [serializedFilterValue]);

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

  const scrollToNodeFn = (id: string) => {
    const itemIndex = state.visibleNodeIds.findIndex((nodeId) => nodeId === id);

    if (itemIndex !== -1) {
      virtualizer.scrollToIndex(itemIndex, { align: "auto" });
    }
  };

  const selectNode = (id: string, scrollToNode = true) => {
    dispatch({ type: "SELECT_NODE", payload: { id, scrollToNode, scrollToNodeFn } });
  };

  const deselectNode = (id: string) => {
    dispatch({ type: "DESELECT_NODE", payload: { id } });
  };

  const deselectAllNodes = () => {
    dispatch({ type: "DESELECT_ALL_NODES" });
  };

  const toggleNodeSelection = (id: string, scrollToNode = true) => {
    dispatch({ type: "TOGGLE_NODE_SELECTION", payload: { id, scrollToNode, scrollToNodeFn } });
  };

  const expandNode = (id: string, scrollToNode = true) => {
    dispatch({ type: "EXPAND_NODE", payload: { id, scrollToNode, scrollToNodeFn } });
  };

  const collapseNode = (id: string) => {
    dispatch({ type: "COLLAPSE_NODE", payload: { id } });
  };

  const toggleExpandNode = (id: string, scrollToNode = true) => {
    dispatch({ type: "TOGGLE_EXPAND_NODE", payload: { id, scrollToNode, scrollToNodeFn } });
  };

  const selectFirstVisibleNode = (scrollToNode = true) => {
    dispatch({
      type: "SELECT_FIRST_VISIBLE_NODE",
      payload: { scrollToNode, scrollToNodeFn },
    });
  };

  const selectLastVisibleNode = (scrollToNode = true) => {
    dispatch({
      type: "SELECT_LAST_VISIBLE_NODE",
      payload: { scrollToNode, scrollToNodeFn },
    });
  };

  const selectNextVisibleNode = (scrollToNode = true) => {
    dispatch({
      type: "SELECT_NEXT_VISIBLE_NODE",
      payload: { scrollToNode, scrollToNodeFn },
    });
  };

  const selectPreviousVisibleNode = (scrollToNode = true) => {
    dispatch({
      type: "SELECT_PREVIOUS_VISIBLE_NODE",
      payload: { scrollToNode, scrollToNodeFn },
    });
  };

  const selectParentNode = (scrollToNode = true) => {
    dispatch({
      type: "SELECT_PARENT_NODE",
      payload: { scrollToNode, scrollToNodeFn },
    });
  };

  const expandAllBelowDepth = (depth: number) => {
    dispatch({ type: "EXPAND_ALL_BELOW_DEPTH", payload: { depth } });
  };

  const collapseAllBelowDepth = (depth: number) => {
    dispatch({ type: "COLLAPSE_ALL_BELOW_DEPTH", payload: { depth } });
  };

  const expandLevel = (level: number) => {
    dispatch({ type: "EXPAND_LEVEL", payload: { level } });
  };

  const collapseLevel = (level: number) => {
    dispatch({ type: "COLLAPSE_LEVEL", payload: { level } });
  };

  const toggleExpandLevel = (level: number) => {
    dispatch({ type: "TOGGLE_EXPAND_LEVEL", payload: { level } });
  };

  const getTreeProps = () => {
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
  };

  const getNodeProps = (id: string) => {
    const node = state.nodes[id];
    if (!node) return {};
    const treeItemIndex = treeIndexById.get(id) ?? -1;
    const treeItem = tree[treeItemIndex];
    return {
      "aria-expanded": node.expanded,
      "aria-level": treeItem.level + 1,
      role: "treeitem",
      tabIndex: node.selected ? -1 : undefined,
    };
  };

  return {
    selected: currentSelectedId,
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
  const indexedItems: { [id: string]: Tree<TData> } = withoutChildren.reduce(
    (acc, item) => {
      acc[item.id] = { id: item.id, runId: item.runId, data: item.data, children: [] };
      return acc;
    },
    {} as { [id: string]: Tree<TData> }
  );

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

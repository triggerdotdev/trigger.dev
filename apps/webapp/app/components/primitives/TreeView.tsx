import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, RefObject, useCallback, useEffect, useRef, useState } from "react";

export type TreeViewProps<TData> = {
  tree: FlatTree<TData>;
  renderParent: (params: { children: React.ReactNode; ref: RefObject<any> }) => JSX.Element;
  estimatedRowHeight: (index: number) => number;
  renderNode: (params: {
    node: FlatTreeItem<TData>;
    state: NodeState & { visibility: NodeVisibility };
  }) => React.ReactNode;
  nodes: TreeState["nodes"];
  autoFocus?: boolean;
};

export function TreeView<TData>({
  tree,
  renderParent,
  renderNode,
  nodes,
  estimatedRowHeight,
  autoFocus = false,
}: TreeViewProps<TData>) {
  const parentRef = useRef<HTMLElement>(null);
  const visibleTreeItems = visibleNodes(tree, nodes);
  const rowVirtualizer = useVirtualizer({
    count: visibleTreeItems.length,
    getItemKey: (index) => visibleTreeItems[index].id,
    getScrollElement: () => parentRef.current,
    estimateSize: estimatedRowHeight,
  });

  useEffect(() => {
    if (autoFocus) {
      parentRef.current?.focus();
    }
  }, [autoFocus, parentRef]);

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
          const node = tree.find((node) => node.id === virtualItem.key)!;
          return (
            <Fragment key={node.id}>
              {renderNode({
                node,
                state: nodes[node.id],
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

export type InputTreeState = Record<string, Partial<NodeState>>;

type TreeStateHookProps = {
  tree: FlatTree<any>;
  selectedId?: string;
  collapsedIds?: string[];
  onStateChanged?: (newState: Changes) => void;
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
  getTreeProps: () => HTMLAttributes;
  getNodeProps: (id: string) => HTMLAttributes;
  selectNode: (id: string) => void;
  deselectNode: (id: string) => void;
  deselectAllNodes: () => void;
  toggleNodeSelection: (id: string) => void;
  expandNode: (id: string) => void;
  collapseNode: (id: string) => void;
  toggleExpandNode: (id: string) => void;
  selectFirstVisibleNode: () => void;
  selectLastVisibleNode: () => void;
  selectNextVisibleNode: () => void;
  selectPreviousVisibleNode: () => void;
  selectParentNode: () => void;
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

export function useTree({
  tree,
  selectedId,
  collapsedIds,
  onStateChanged,
}: TreeStateHookProps): TreeState {
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

  const selectNode = useCallback(
    (id: string) => {
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
    (id: string) => {
      const currentlySelected = state[id]?.selected ?? false;
      if (currentlySelected) {
        deselectNode(id);
      } else {
        selectNode(id);
      }
    },
    [state]
  );

  const expandNode = useCallback(
    (id: string) => {
      modifyState((state) => ({
        ...state,
        [id]: { ...state[id], expanded: true },
      }));
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
    (id: string) => {
      const currentlyExpanded = state[id]?.expanded ?? false;
      if (currentlyExpanded) {
        collapseNode(id);
      } else {
        expandNode(id);
      }
    },
    [state]
  );

  const selectFirstVisibleNode = useCallback(() => {
    const firstVisibleNode = tree.find((node) => nodes[node.id].visibility === "visible");
    if (firstVisibleNode) {
      selectNode(firstVisibleNode.id);
    }
  }, [tree, state]);

  const selectLastVisibleNode = useCallback(() => {
    const lastVisibleNode = tree
      .slice()
      .reverse()
      .find((node) => nodes[node.id].visibility === "visible");
    if (lastVisibleNode) {
      selectNode(lastVisibleNode.id);
    }
  }, [tree, state]);

  const selectNextVisibleNode = useCallback(() => {
    if (!selected) {
      selectFirstVisibleNode();
      return;
    }

    const visible = visibleNodes(tree, nodes);
    const selectedIndex = visible.findIndex((node) => node.id === selected);
    const nextNode = visible[selectedIndex + 1];
    if (nextNode) {
      selectNode(nextNode.id);
    }
  }, [selected, state]);

  const selectPreviousVisibleNode = useCallback(() => {
    if (!selected) {
      selectFirstVisibleNode();
      return;
    }

    const visible = visibleNodes(tree, nodes);
    const selectedIndex = visible.findIndex((node) => node.id === selected);
    const previousNode = visible[selectedIndex - 1];
    if (previousNode) {
      selectNode(previousNode.id);
    }
  }, [selected, state]);

  const selectParentNode = useCallback(() => {
    if (!selected) {
      selectFirstVisibleNode();
      return;
    }

    const selectedNode = tree.find((node) => node.id === selected);
    if (!selectedNode) {
      return;
    }

    const parentNode = tree.find((node) => node.id === selectedNode.parentId);
    if (parentNode) {
      selectNode(parentNode.id);
    }
  }, [selected, state]);

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
            selectFirstVisibleNode();
            e.preventDefault();
            break;
          }
          case "End": {
            selectLastVisibleNode();
            e.preventDefault();
            break;
          }
          case "Down":
          case "ArrowDown": {
            selectNextVisibleNode();
            e.preventDefault();
            break;
          }
          case "Up":
          case "ArrowUp": {
            selectPreviousVisibleNode();
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
                selectParentNode();
              }
            }
            e.preventDefault();
            break;
          }
          case "Right":
          case "ArrowRight": {
            if (selected) {
              expandNode(selected);
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

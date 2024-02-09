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
};

export function TreeView<TData>({
  tree,
  renderParent,
  renderNode,
  nodes,
  estimatedRowHeight,
}: TreeViewProps<TData>) {
  const parentRef = useRef<HTMLElement>(null);
  const visibleTreeItems = visibleNodes(tree, nodes);
  const rowVirtualizer = useVirtualizer({
    count: visibleTreeItems.length,
    getItemKey: (index) => visibleTreeItems[index].id,
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
  defaultState?: InputTreeState;
  onStateChanged?: (newState: InputTreeState) => void;
};

type TreeState = {
  selected: string | undefined;
  nodes: Record<
    string,
    NodeState & {
      visibility: NodeVisibility;
    }
  >;
  selectNode: (id: string) => void;
  deselectNode: (id: string) => void;
  deselectAllNodes: () => void;
  toggleNodeSelection: (id: string) => void;
  expandNode: (id: string) => void;
  collapseNode: (id: string) => void;
  toggleExpandNode: (id: string) => void;
  // selectNextVisibleNode: () => void;
  // selectPreviousVisibleNode: () => void;
};

type ModifyState = ((state: InputTreeState) => InputTreeState) | InputTreeState;

const defaultSelected = false;
const defaultExpanded = true;

export function useTree({ tree, defaultState, onStateChanged }: TreeStateHookProps): TreeState {
  const [state, setState] = useState<InputTreeState>(defaultState ?? {});

  const modifyState = useCallback(
    (input: ModifyState) => {
      if (typeof input === "function") {
        setState((state) => {
          const updatedState = input(state);
          onStateChanged?.(stripOutDefault(updatedState));
          return updatedState;
        });
        return;
      }

      setState(input);
      onStateChanged?.(stripOutDefault(input));
    },
    [state]
  );

  //if the defaultState changes, update the state
  useEffect(() => {
    modifyState(defaultState ?? {});
  }, [defaultState]);

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

  return {
    selected,
    nodes,
    selectNode,
    deselectNode,
    deselectAllNodes,
    toggleNodeSelection,
    expandNode,
    collapseNode,
    toggleExpandNode,
  };
}

function visibleNodes(tree: FlatTree<any>, nodes: TreeState["nodes"]) {
  return tree.filter((node) => nodes[node.id].visibility === "visible");
}

function stripOutDefault(input: InputTreeState): InputTreeState {
  //if selected === defaultSelected, remove it
  //if expanded === defaultExpanded, remove it
  //if both are default, remove the node
  return Object.fromEntries(
    Object.entries(input).filter(([id, state]) => {
      return state.selected !== defaultSelected || state.expanded !== defaultExpanded;
    })
  );
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

import type { Filter, FlatTree } from "./TreeView";
import type { NodeState, NodesState, TreeState } from "./reducer";

type PartialNodeState = Record<string, Partial<NodeState>>;

const defaultSelected = false;
const defaultExpanded = true;

export function concreteStateFromInput({
  tree,
  filter,
  selectedId,
  collapsedIds,
  openSelectedAncestors = true,
}: {
  tree: FlatTree<any>;
  filter: Filter<any, any> | undefined;
  selectedId: string | undefined;
  collapsedIds: string[] | undefined;
  /** Off on rebuilds, so ancestors the user collapsed stay collapsed. */
  openSelectedAncestors?: boolean;
}): TreeState {
  const state: PartialNodeState = {};
  if (collapsedIds && collapsedIds.length > 0) {
    const treeIds = new Set(tree.map((item) => item.id));
    collapsedIds.forEach((id) => {
      if (treeIds.has(id)) {
        state[id] = { expanded: false };
      }
    });
  }
  if (selectedId) {
    const selectedNode = tree.find((node) => node.id === selectedId);
    if (selectedNode) {
      // Keep a collapsed selection collapsed when the tree is rebuilt.
      state[selectedId] = { ...state[selectedId], selected: true };
      //make sure all parents are expanded
      let parentId = openSelectedAncestors ? selectedNode.parentId : undefined;
      while (parentId) {
        state[parentId] = { expanded: true };
        const parent = tree.find((node) => node.id === parentId);
        parentId = parent?.parentId;
      }
    }
  }
  const nodes = concreteStateFromPartialState(tree, state);

  return applyFilterToState({
    tree,
    nodes,
    filter,
    filteredNodes: nodes,
    visibleNodeIds: [],
  });
}

function concreteStateFromPartialState<TData>(
  tree: FlatTree<TData>,
  state: PartialNodeState
): NodesState {
  const concreteState = tree.reduce(
    (acc, node) => {
      acc[node.id] = {
        selected: acc[node.id]?.selected ?? defaultSelected,
        expanded: acc[node.id]?.expanded ?? defaultExpanded,
        visible: acc[node.id]?.visible ?? true,
      };
      return acc;
    },
    state as Record<string, NodeState>
  );

  return applyVisibility(tree, concreteState);
}

/** `changed` overrides some nodes' state first, so callers needn't copy every node to do it. */
export function applyVisibility<TData>(
  tree: FlatTree<TData>,
  state: NodesState,
  changed?: PartialNodeState
): NodesState {
  const newState = tree.reduce((acc, node) => {
    //groups are open by default
    const current = state[node.id] ?? {
      selected: defaultSelected,
      expanded: node.hasChildren ? defaultExpanded : !defaultExpanded,
    };
    const change = changed?.[node.id];
    const nodeState = change ? { ...current, ...change } : current;
    const parent = node.parentId
      ? acc[node.parentId]
      : { selected: defaultSelected, expanded: defaultExpanded, visible: true };
    const visible = parent.expanded && parent.visible === true;
    acc[node.id] = { ...nodeState, visible };

    return acc;
  }, {} as NodesState);

  return newState;
}

export function selectedIdFromState(state: NodesState): string | undefined {
  // A plain loop: Object.entries builds an array per node, which shows on big trees.
  for (const id in state) {
    if (state[id].selected) return id;
  }
  return undefined;
}

export function applyFilterToState<_TData>({
  tree,
  nodes,
  filter,
  visibleNodeIds,
}: TreeState): TreeState {
  if (!filter || !filter.value) {
    return {
      tree,
      nodes,
      filteredNodes: nodes,
      filter,
      visibleNodeIds: visibleNodes(tree, nodes).map((node) => node.id),
    };
  }

  //we need to do two passes, first collect all the nodes that are results
  const newFilteredOut = new Set<string>();
  for (const node of tree) {
    if (!filter.fn(filter.value, node)) {
      newFilteredOut.add(node.id);
    }
  }

  //nothing is filtered out
  if (newFilteredOut.size === 0) {
    return {
      tree,
      nodes,
      filteredNodes: nodes,
      filter,
      visibleNodeIds: visibleNodes(tree, nodes).map((node) => node.id),
    };
  }

  //copy of nodes
  const filteredNodes = { ...nodes };

  const selected = selectedIdFromState(filteredNodes);

  const visible = new Set<string>();
  const expanded = new Set<string>();

  // Built once per pass: looking parents and children up in the array made this O(n²).
  const parentById = new Map<string, string | undefined>();
  const childrenById = new Map<string, FlatTree<any>>();
  for (const node of tree) {
    parentById.set(node.id, node.parentId);
    if (node.parentId === undefined) continue;
    const siblings = childrenById.get(node.parentId);
    if (siblings) siblings.push(node);
    else childrenById.set(node.parentId, [node]);
  }

  //figure out the state of each node
  for (const node of tree) {
    const shouldDisplay = !newFilteredOut.has(node.id);

    //if the node is visible, make all the parents visible and expanded
    if (shouldDisplay) {
      //should be visible
      visible.add(node.id);
      //if it has children it should be expanded
      if (node.hasChildren) {
        expanded.add(node.id);
      }

      // Parents need to be visible and expanded. An expanded parent already has its own
      // parents done, so the walk stops there.
      let parentId = node.parentId;
      while (parentId && !expanded.has(parentId)) {
        visible.add(parentId);
        expanded.add(parentId);
        parentId = parentById.get(parentId);
      }

      //children should be  visible and if they have children expanded
      if (node.hasChildren) {
        const children = childrenById.get(node.id) ?? [];
        for (const child of children) {
          visible.add(child.id);
          if (child.hasChildren) {
            expanded.add(child.id);
          }
        }
      }
    }
  }

  const allItems = new Set(tree.map((node) => node.id));
  const hidden = difference(allItems, visible);
  const collapsed = difference(visible, expanded);

  //now set the visibility and expanded state
  for (const id of hidden) {
    filteredNodes[id] = { ...filteredNodes[id], visible: false };
  }
  for (const id of visible) {
    filteredNodes[id] = { ...filteredNodes[id], visible: true };
  }

  for (const id of collapsed) {
    filteredNodes[id] = { ...filteredNodes[id], expanded: false };
  }
  for (const id of expanded) {
    filteredNodes[id] = { ...filteredNodes[id], expanded: true };
  }

  if (selected) {
    if (visible.has(selected)) {
      filteredNodes[selected] = { ...filteredNodes[selected], selected: true };
    } else {
      filteredNodes[selected] = { ...filteredNodes[selected], selected: false };
    }
  }

  return {
    tree,
    nodes,
    filteredNodes,
    filter,
    visibleNodeIds: visibleNodes(tree, filteredNodes).map((node) => node.id),
  };
}

export function visibleNodes(tree: FlatTree<any>, nodes: NodesState) {
  return tree.filter((node) => nodes[node.id].visible === true);
}

export function firstVisibleNode(tree: FlatTree<any>, nodes: NodesState) {
  return tree.find((node) => nodes[node.id].visible === true);
}

export function lastVisibleNode(tree: FlatTree<any>, nodes: NodesState) {
  return tree
    .slice()
    .reverse()
    .find((node) => nodes[node.id].visible === true);
}
function difference<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set([...a].filter((x) => !b.has(x)));
}

export function collapsedIdsFromState(state: NodesState): string[] {
  return Object.entries(state)
    .filter(([_, s]) => s.expanded === false)
    .map(([id]) => id);
}

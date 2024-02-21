import { FlatTree, FlatTreeItem } from "./TreeView";
import { Changes, NodeState, NodesState, TreeState } from "./reducer";

type PartialNodeState = Record<string, Partial<NodeState>>;

const defaultSelected = false;
const defaultExpanded = true;

export function concreteStateFromInput({
  tree,
  selectedId,
  collapsedIds,
}: {
  tree: FlatTree<any>;
  selectedId: string | undefined;
  collapsedIds: string[] | undefined;
}): TreeState {
  const state: PartialNodeState = {};
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

  return {
    nodes: concreteStateFromPartialState(tree, state),
    changes: { selectedId, collapsedIds: [] },
  };
}

export function concreteStateFromPartialState<TData>(
  tree: FlatTree<TData>,
  state: PartialNodeState
): NodesState {
  const concreteState = tree.reduce((acc, node) => {
    acc[node.id] = {
      selected: acc[node.id]?.selected ?? defaultSelected,
      expanded: acc[node.id]?.expanded ?? defaultExpanded,
      visible: acc[node.id]?.visible ?? true,
    };
    return acc;
  }, state as Record<string, NodeState>);

  return applyVisibility(tree, concreteState);
}

export function applyVisibility<TData>(tree: FlatTree<TData>, state: NodesState): NodesState {
  const newState = tree.reduce((acc, node) => {
    //groups are open by default
    const nodeState = state[node.id] ?? {
      selected: defaultSelected,
      expanded: node.hasChildren ? defaultExpanded : !defaultExpanded,
    };
    const parent = node.parentId
      ? acc[node.parentId]
      : { selected: defaultSelected, expanded: defaultExpanded, visible: true };
    const visible = parent.expanded && parent.visible === true ? true : false;
    acc[node.id] = { ...nodeState, visible };

    return acc;
  }, {} as NodesState);

  return newState;
}

export function selectedIdFromState(state: NodesState): string | undefined {
  const selected = Object.entries(state).find(([id, node]) => node.selected);
  return selected?.[0];
}

export function applyFilterToState<TData>(
  tree: FlatTree<TData>,
  inputNodes: NodesState,
  filter: (node: FlatTreeItem<TData>) => boolean
): NodesState {
  //we need to do two passes, first collect all the nodes that are results
  const newFilteredOut = new Set<string>();
  for (const node of tree) {
    if (!filter(node)) {
      newFilteredOut.add(node.id);
    }
  }

  //nothing is filtered out
  if (newFilteredOut.size === 0) {
    return inputNodes;
  }

  //copy of nodes
  const nodes = { ...inputNodes };

  const selected = selectedIdFromState(nodes);

  const visible = new Set<string>();
  const expanded = new Set<string>();

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

      //parents need to be both visible and expanded
      let parentId = node.parentId;
      while (parentId) {
        visible.add(parentId);
        expanded.add(parentId);
        parentId = tree.find((node) => node.id === parentId)?.parentId;
      }

      //children should be  visible and if they have children expanded
      if (node.hasChildren) {
        const children = tree.filter((child) => child.parentId === node.id);
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
    nodes[id] = { ...nodes[id], visible: false };
  }
  for (const id of visible) {
    nodes[id] = { ...nodes[id], visible: true };
  }

  for (const id of collapsed) {
    nodes[id] = { ...nodes[id], expanded: false };
  }
  for (const id of expanded) {
    nodes[id] = { ...nodes[id], expanded: true };
  }

  if (selected) {
    if (visible.has(selected)) {
      nodes[selected] = { ...nodes[selected], selected: true };
    } else {
      nodes[selected] = { ...nodes[selected], selected: false };
    }
  }

  return nodes;
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

function areSetsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function difference<T>(a: Set<T>, b: Set<T>): Set<T> {
  return new Set([...a].filter((x) => !b.has(x)));
}

function collapsedIdsFromState(state: NodesState): string[] {
  return Object.entries(state)
    .filter(([_, s]) => s.expanded === false)
    .map(([id]) => id);
}

export function generateChanges(a: NodesState, b: NodesState): Changes {
  //if selected === defaultSelected, remove it
  //if expanded === defaultExpanded, remove it
  //if both are default, remove the node
  const selectedIdA = selectedIdFromState(a);
  const selectedIdB = selectedIdFromState(b);

  const collapsedIdsA = new Set(collapsedIdsFromState(a));
  const collapsedIdsB = new Set(collapsedIdsFromState(b));

  const collapsedChanges = [...difference(collapsedIdsA, collapsedIdsB)];

  return {
    selectedId: selectedIdA !== selectedIdB ? selectedIdB : undefined,
    collapsedIds: collapsedChanges.length > 0 ? collapsedChanges : undefined,
  };
}

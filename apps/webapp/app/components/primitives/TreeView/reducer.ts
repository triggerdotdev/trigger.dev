import assertNever from "assert-never";
import { Filter, FlatTree } from "./TreeView";
import {
  applyFilterToState,
  applyVisibility,
  collapsedIdsFromState,
  concreteStateFromInput,
  firstVisibleNode,
  generateChanges,
  lastVisibleNode,
  selectedIdFromState,
  visibleNodes,
} from "./utils";

export type NodeState = {
  selected: boolean;
  expanded: boolean;
  visible: boolean;
};

export type Changes = {
  selectedId: string | undefined;
};

export type TreeState = {
  tree: FlatTree<any>;
  nodes: NodesState;
  filteredNodes: NodesState;
  changes: Changes;
  filter: Filter<any, any> | undefined;
  visibleNodeIds: string[];
};

export type NodesState = Record<string, NodeState>;

type ScrollToNodeFn = (id: string) => void;

type WithScrollToNode = {
  scrollToNode: boolean;
  scrollToNodeFn: ScrollToNodeFn;
};

type UpdateTreeAction = {
  type: "UPDATE_TREE";
  payload: {
    tree: FlatTree<any>;
  };
};

type SelectNodeAction = {
  type: "SELECT_NODE";
  payload: {
    id: string;
  } & WithScrollToNode;
};

type DeselectNodeAction = {
  type: "DESELECT_NODE";
  payload: {
    id: string;
  };
};

type DeselectAllNodesAction = {
  type: "DESELECT_ALL_NODES";
};

type ToggleNodeSelection = {
  type: "TOGGLE_NODE_SELECTION";
  payload: {
    id: string;
  } & WithScrollToNode;
};

type ExpandNodeAction = {
  type: "EXPAND_NODE";
  payload: {
    id: string;
  } & WithScrollToNode;
};

type CollapseNodeAction = {
  type: "COLLAPSE_NODE";
  payload: {
    id: string;
  };
};

type ToggleExpandNodeAction = {
  type: "TOGGLE_EXPAND_NODE";
  payload: {
    id: string;
  } & WithScrollToNode;
};

type ExpandAllBelowDepthAction = {
  type: "EXPAND_ALL_BELOW_DEPTH";
  payload: {
    depth: number;
  };
};

type CollapseAllBelowDepthAction = {
  type: "COLLAPSE_ALL_BELOW_DEPTH";
  payload: {
    depth: number;
  };
};

type ExpandLevelAction = {
  type: "EXPAND_LEVEL";
  payload: {
    level: number;
  };
};

type CollapseLevelAction = {
  type: "COLLAPSE_LEVEL";
  payload: {
    level: number;
  };
};

type ToggleExpandLevelAction = {
  type: "TOGGLE_EXPAND_LEVEL";
  payload: {
    level: number;
  };
};

type SelectFirstVisibleNodeAction = {
  type: "SELECT_FIRST_VISIBLE_NODE";
  payload: {} & WithScrollToNode;
};

type SelectLastVisibleNodeAction = {
  type: "SELECT_LAST_VISIBLE_NODE";
  payload: {} & WithScrollToNode;
};

type SelectNextVisibleNodeAction = {
  type: "SELECT_NEXT_VISIBLE_NODE";
  payload: {} & WithScrollToNode;
};

type SelectPreviousVisibleNodeAction = {
  type: "SELECT_PREVIOUS_VISIBLE_NODE";
  payload: {} & WithScrollToNode;
};

type SelectParentNodeAction = {
  type: "SELECT_PARENT_NODE";
  payload: {} & WithScrollToNode;
};

type UpdateFilterAction = {
  type: "UPDATE_FILTER";
  payload: {
    filter: Filter<any, any> | undefined;
  };
};

export type Action =
  | UpdateTreeAction
  | SelectNodeAction
  | DeselectNodeAction
  | DeselectAllNodesAction
  | ToggleNodeSelection
  | ExpandNodeAction
  | CollapseNodeAction
  | ToggleExpandNodeAction
  | ExpandAllBelowDepthAction
  | CollapseAllBelowDepthAction
  | ExpandLevelAction
  | CollapseLevelAction
  | ToggleExpandLevelAction
  | SelectFirstVisibleNodeAction
  | SelectLastVisibleNodeAction
  | SelectNextVisibleNodeAction
  | SelectPreviousVisibleNodeAction
  | SelectParentNodeAction
  | UpdateFilterAction;

export function reducer(state: TreeState, action: Action): TreeState {
  switch (action.type) {
    case "SELECT_NODE": {
      //if the node was already selected, do nothing. The user needs to use deselectNode to deselect
      const alreadySelected = state.nodes[action.payload.id]?.selected ?? false;
      if (alreadySelected) {
        return state;
      }

      const newNodes = Object.fromEntries(
        Object.entries(state.nodes).map(([key, value]) => [key, { ...value, selected: false }])
      );
      newNodes[action.payload.id] = { ...newNodes[action.payload.id], selected: true };

      if (action.payload.scrollToNode) {
        action.payload.scrollToNodeFn(action.payload.id);
      }

      return applyFilterToState({
        ...state,
        tree: state.tree,
        nodes: newNodes,
        changes: generateChanges(state.nodes, newNodes),
      });
    }
    case "DESELECT_NODE": {
      const nodes = {
        ...state.nodes,
        [action.payload.id]: { ...state.nodes[action.payload.id], selected: false },
      };

      return applyFilterToState({
        ...state,
        nodes,
        changes: generateChanges(state.nodes, nodes),
      });
    }
    case "DESELECT_ALL_NODES": {
      const nodes = Object.fromEntries(
        Object.entries(state.nodes).map(([key, value]) => [key, { ...value, selected: false }])
      );
      return applyFilterToState({
        ...state,
        nodes,
        changes: generateChanges(state.nodes, nodes),
      });
    }
    case "TOGGLE_NODE_SELECTION": {
      const currentlySelected = state.nodes[action.payload.id]?.selected ?? false;
      if (currentlySelected) {
        return reducer(state, { type: "DESELECT_NODE", payload: { id: action.payload.id } });
      }

      return reducer(state, {
        type: "SELECT_NODE",
        payload: {
          id: action.payload.id,
          scrollToNode: action.payload.scrollToNode,
          scrollToNodeFn: action.payload.scrollToNodeFn,
        },
      });
    }
    case "EXPAND_NODE": {
      const newNodes = {
        ...state.nodes,
        [action.payload.id]: { ...state.nodes[action.payload.id], expanded: true },
      };

      if (action.payload.scrollToNode) {
        action.payload.scrollToNodeFn(action.payload.id);
      }

      const visibleNodes = applyVisibility(state.tree, newNodes);
      return applyFilterToState({
        ...state,
        nodes: visibleNodes,
        changes: generateChanges(state.nodes, visibleNodes),
      });
    }
    case "COLLAPSE_NODE": {
      const visibleNodes = applyVisibility(state.tree, {
        ...state.nodes,
        [action.payload.id]: { ...state.nodes[action.payload.id], expanded: false },
      });
      return applyFilterToState({
        ...state,
        nodes: visibleNodes,
        changes: generateChanges(state.nodes, visibleNodes),
      });
    }
    case "TOGGLE_EXPAND_NODE": {
      const currentlyExpanded = state.nodes[action.payload.id]?.expanded ?? true;
      if (currentlyExpanded) {
        return reducer(state, {
          type: "COLLAPSE_NODE",
          payload: { id: action.payload.id },
        });
      }

      return reducer(state, {
        type: "EXPAND_NODE",
        payload: {
          id: action.payload.id,
          scrollToNode: action.payload.scrollToNode,
          scrollToNodeFn: action.payload.scrollToNodeFn,
        },
      });
    }
    case "EXPAND_ALL_BELOW_DEPTH": {
      const nodesToExpand = state.tree.filter(
        (n) => n.level >= action.payload.depth && n.hasChildren
      );

      const newNodes = Object.fromEntries(
        Object.entries(state.nodes).map(([key, value]) => [
          key,
          {
            ...value,
            expanded: nodesToExpand.find((n) => n.id === key) ? true : value.expanded,
          },
        ])
      );

      const visibleNodes = applyVisibility(state.tree, newNodes);
      return applyFilterToState({
        ...state,
        nodes: visibleNodes,
        changes: generateChanges(state.nodes, visibleNodes),
      });
    }
    case "COLLAPSE_ALL_BELOW_DEPTH": {
      const nodesToCollapse = state.tree.filter(
        (n) => n.level >= action.payload.depth && n.hasChildren
      );

      const newNodes = Object.fromEntries(
        Object.entries(state.nodes).map(([key, value]) => [
          key,
          {
            ...value,
            expanded: nodesToCollapse.find((n) => n.id === key) ? false : value.expanded,
          },
        ])
      );

      const visibleNodes = applyVisibility(state.tree, newNodes);
      return applyFilterToState({
        ...state,
        nodes: visibleNodes,
        changes: generateChanges(state.nodes, visibleNodes),
      });
    }
    case "EXPAND_LEVEL": {
      const nodesToExpand = state.tree.filter(
        (n) => n.level <= action.payload.level && n.hasChildren
      );

      const newNodes = Object.fromEntries(
        Object.entries(state.nodes).map(([key, value]) => [
          key,
          {
            ...value,
            expanded: nodesToExpand.find((n) => n.id === key) ? true : value.expanded,
          },
        ])
      );

      const visibleNodes = applyVisibility(state.tree, newNodes);
      return applyFilterToState({
        ...state,
        nodes: visibleNodes,
        changes: generateChanges(state.nodes, visibleNodes),
      });
    }
    case "COLLAPSE_LEVEL": {
      const nodesToCollapse = state.tree.filter(
        (n) => n.level === action.payload.level && n.hasChildren
      );

      const newNodes = Object.fromEntries(
        Object.entries(state.nodes).map(([key, value]) => [
          key,
          {
            ...value,
            expanded: nodesToCollapse.find((n) => n.id === key) ? false : value.expanded,
          },
        ])
      );

      const visibleNodes = applyVisibility(state.tree, newNodes);
      return applyFilterToState({
        ...state,
        nodes: visibleNodes,
        changes: generateChanges(state.nodes, visibleNodes),
      });
    }
    case "TOGGLE_EXPAND_LEVEL": {
      //first get the first item at that level in the tree. If it is expanded, collapse all nodes at that level
      //if it is collapsed, expand all nodes at that level
      const nodesAtLevel = state.tree.filter(
        (n) => n.level === action.payload.level && n.hasChildren
      );
      const firstNode = nodesAtLevel[0];
      if (!firstNode) {
        return state;
      }

      const currentlyExpanded = state.nodes[firstNode.id]?.expanded ?? true;
      const currentVisible = state.nodes[firstNode.id]?.visible ?? true;
      if (currentlyExpanded && currentVisible) {
        return reducer(state, {
          type: "COLLAPSE_LEVEL",
          payload: {
            level: action.payload.level,
          },
        });
      }

      return reducer(state, {
        type: "EXPAND_LEVEL",
        payload: {
          level: action.payload.level,
        },
      });
    }
    case "SELECT_FIRST_VISIBLE_NODE": {
      const node = firstVisibleNode(state.tree, state.filteredNodes);
      if (node) {
        return reducer(state, {
          type: "SELECT_NODE",
          payload: {
            id: node.id,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      return state;
    }
    case "SELECT_LAST_VISIBLE_NODE": {
      const node = lastVisibleNode(state.tree, state.filteredNodes);
      if (node) {
        return reducer(state, {
          type: "SELECT_NODE",
          payload: {
            id: node.id,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      return state;
    }
    case "SELECT_NEXT_VISIBLE_NODE": {
      const selected = selectedIdFromState(state.nodes);
      if (!selected) {
        return reducer(state, {
          type: "SELECT_FIRST_VISIBLE_NODE",
          payload: {
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      const visible = visibleNodes(state.tree, state.filteredNodes);
      const selectedIndex = visible.findIndex((node) => node.id === selected);
      const nextNode = visible[selectedIndex + 1];
      if (nextNode) {
        return reducer(state, {
          type: "SELECT_NODE",
          payload: {
            id: nextNode.id,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      return state;
    }
    case "SELECT_PREVIOUS_VISIBLE_NODE": {
      const selected = selectedIdFromState(state.nodes);

      if (!selected) {
        return reducer(state, {
          type: "SELECT_FIRST_VISIBLE_NODE",
          payload: {
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      const visible = visibleNodes(state.tree, state.filteredNodes);
      const selectedIndex = visible.findIndex((node) => node.id === selected);
      const previousNode = visible[Math.max(0, selectedIndex - 1)];
      if (previousNode) {
        return reducer(state, {
          type: "SELECT_NODE",
          payload: {
            id: previousNode.id,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      return state;
    }
    case "SELECT_PARENT_NODE": {
      const selected = selectedIdFromState(state.nodes);

      if (!selected) {
        return reducer(state, {
          type: "SELECT_FIRST_VISIBLE_NODE",
          payload: {
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      const selectedNode = state.tree.find((node) => node.id === selected);
      if (!selectedNode) {
        return state;
      }

      const parentNode = state.tree.find((node) => node.id === selectedNode.parentId);
      if (parentNode) {
        return reducer(state, {
          type: "SELECT_NODE",
          payload: {
            id: parentNode.id,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      return state;
    }
    case "UPDATE_TREE": {
      //update the tree but try and keep the selected and expanded states
      const selectedId = selectedIdFromState(state.nodes);
      const collapsedIds = collapsedIdsFromState(state.nodes);
      const newState = concreteStateFromInput({
        ...state,
        tree: action.payload.tree,
        selectedId,
        collapsedIds,
      });
      return newState;
    }
    case "UPDATE_FILTER": {
      const newState = applyFilterToState({
        ...state,
        filter: action.payload.filter,
      });
      return newState;
    }
    default: {
      assertNever(action);
    }
  }

  throw new Error(`Unhandled action type: ${(action as any).type}`);
}

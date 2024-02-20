import { FlatTree } from "./TreeView";
import {
  applyVisibility,
  firstVisibleNode,
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
  collapsedIds: string[];
};

export type TreeState = {
  nodes: NodesState;
  changes: Changes;
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
    tree: FlatTree<any>;
  } & WithScrollToNode;
};

type CollapseNodeAction = {
  type: "COLLAPSE_NODE";
  payload: {
    id: string;
    tree: FlatTree<any>;
  };
};

type ToggleExpandNodeAction = {
  type: "TOGGLE_EXPAND_NODE";
  payload: {
    id: string;
    tree: FlatTree<any>;
  } & WithScrollToNode;
};

type SelectFirstVisibleNodeAction = {
  type: "SELECT_FIRST_VISIBLE_NODE";
  payload: {
    tree: FlatTree<any>;
  } & WithScrollToNode;
};

type SelectLastVisibleNodeAction = {
  type: "SELECT_LAST_VISIBLE_NODE";
  payload: {
    tree: FlatTree<any>;
  } & WithScrollToNode;
};

type SelectNextVisibleNodeAction = {
  type: "SELECT_NEXT_VISIBLE_NODE";
  payload: {
    tree: FlatTree<any>;
  } & WithScrollToNode;
};

type SelectPreviousVisibleNodeAction = {
  type: "SELECT_PREVIOUS_VISIBLE_NODE";
  payload: {
    tree: FlatTree<any>;
  } & WithScrollToNode;
};

type SelectParentNodeAction = {
  type: "SELECT_PARENT_NODE";
  payload: {
    tree: FlatTree<any>;
  } & WithScrollToNode;
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
  | SelectFirstVisibleNodeAction
  | SelectLastVisibleNodeAction
  | SelectNextVisibleNodeAction
  | SelectPreviousVisibleNodeAction
  | SelectParentNodeAction;

export function reducer(state: NodesState, action: Action): NodesState {
  switch (action.type) {
    case "SELECT_NODE": {
      //if the node was already selected, do nothing. The user needs to use deselectNode to deselect
      const alreadySelected = state[action.payload.id]?.selected ?? false;
      if (alreadySelected) {
        return state;
      }

      const newState = Object.fromEntries(
        Object.entries(state).map(([key, value]) => [key, { ...value, selected: false }])
      );
      newState[action.payload.id] = { ...newState[action.payload.id], selected: true };

      if (action.payload.scrollToNode) {
        action.payload.scrollToNodeFn(action.payload.id);
      }

      return newState;
    }
    case "DESELECT_NODE": {
      return {
        ...state,
        [action.payload.id]: { ...state[action.payload.id], selected: false },
      };
    }
    case "DESELECT_ALL_NODES": {
      return Object.fromEntries(
        Object.entries(state).map(([key, value]) => [key, { ...value, selected: false }])
      );
    }
    case "TOGGLE_NODE_SELECTION": {
      const currentlySelected = state[action.payload.id]?.selected ?? false;
      if (currentlySelected) {
        return reducer(state, { type: "DESELECT_NODE", payload: { id: action.payload.id } });
      } else {
        return reducer(state, {
          type: "SELECT_NODE",
          payload: {
            id: action.payload.id,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }
    }
    case "EXPAND_NODE": {
      const newState = {
        ...state,
        [action.payload.id]: { ...state[action.payload.id], expanded: true },
      };

      if (action.payload.scrollToNode) {
        action.payload.scrollToNodeFn(action.payload.id);
      }

      return applyVisibility(action.payload.tree, newState);
    }
    case "COLLAPSE_NODE": {
      return applyVisibility(action.payload.tree, {
        ...state,
        [action.payload.id]: { ...state[action.payload.id], expanded: false },
      });
    }
    case "TOGGLE_EXPAND_NODE": {
      const currentlyExpanded = state[action.payload.id]?.expanded ?? true;
      if (currentlyExpanded) {
        return reducer(state, {
          type: "COLLAPSE_NODE",
          payload: { id: action.payload.id, tree: action.payload.tree },
        });
      } else {
        return reducer(state, {
          type: "EXPAND_NODE",
          payload: {
            id: action.payload.id,
            tree: action.payload.tree,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }
    }
    case "SELECT_FIRST_VISIBLE_NODE": {
      const node = firstVisibleNode(action.payload.tree, state);
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
    }
    case "SELECT_LAST_VISIBLE_NODE": {
      const node = lastVisibleNode(action.payload.tree, state);
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
    }
    case "SELECT_NEXT_VISIBLE_NODE": {
      const selected = selectedIdFromState(state);
      if (!selected) {
        return reducer(state, {
          type: "SELECT_FIRST_VISIBLE_NODE",
          payload: {
            tree: action.payload.tree,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      const visible = visibleNodes(action.payload.tree, state);
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
    }
    case "SELECT_PREVIOUS_VISIBLE_NODE": {
      const selected = selectedIdFromState(state);

      if (!selected) {
        return reducer(state, {
          type: "SELECT_FIRST_VISIBLE_NODE",
          payload: {
            tree: action.payload.tree,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      const visible = visibleNodes(action.payload.tree, state);
      const selectedIndex = visible.findIndex((node) => node.id === selected);
      const previousNode = visible[selectedIndex - 1];
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
      const selected = selectedIdFromState(state);

      if (!selected) {
        return reducer(state, {
          type: "SELECT_FIRST_VISIBLE_NODE",
          payload: {
            tree: action.payload.tree,
            scrollToNode: action.payload.scrollToNode,
            scrollToNodeFn: action.payload.scrollToNodeFn,
          },
        });
      }

      const selectedNode = action.payload.tree.find((node) => node.id === selected);
      if (!selectedNode) {
        return state;
      }

      const parentNode = action.payload.tree.find((node) => node.id === selectedNode.parentId);
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
  }

  throw new Error(`Unhandled action type: ${(action as any).type}`);
}

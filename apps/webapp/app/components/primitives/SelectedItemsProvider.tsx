"use client";

import { createContext, useCallback, useContext, useReducer } from "react";

type SelectedItemsContext = {
  selectedItems: Set<string>;
  select: (items: string | string[]) => void;
  deselect: (items: string | string[]) => void;
  toggle: (items: string | string[]) => void;
  deselectAll: () => void;
  has: (item: string) => boolean;
  hasAll: (items: string[]) => boolean;
};

const SelectedItemsContext = createContext<SelectedItemsContext>({} as SelectedItemsContext);

export function useSelectedItems(enabled = true) {
  const context = useContext(SelectedItemsContext);
  if (!context && enabled) {
    throw new Error("useSelectedItems must be used within a SelectedItemsProvider");
  }

  return context;
}

export function SelectedItemsProvider({
  initialSelectedItems,
  children,
}: {
  initialSelectedItems: string[];
  children: React.ReactNode | ((context: SelectedItemsContext) => React.ReactNode);
}) {
  const [state, dispatch] = useReducer(selectedItemsReducer, new Set<string>(initialSelectedItems));

  const select = useCallback((items: string | string[]) => {
    dispatch({ type: "select", items: Array.isArray(items) ? items : [items] });
  }, []);

  const deselect = useCallback((items: string | string[]) => {
    dispatch({ type: "deselect", items: Array.isArray(items) ? items : [items] });
  }, []);

  const toggle = useCallback((items: string | string[]) => {
    dispatch({ type: "toggle", items: Array.isArray(items) ? items : [items] });
  }, []);

  const deselectAll = useCallback(() => {
    dispatch({ type: "deselectAll" });
  }, []);

  const has = useCallback((item: string) => state.has(item), [state]);

  const hasAll = useCallback((items: string[]) => items.every((item) => state.has(item)), [state]);

  return (
    <SelectedItemsContext.Provider
      value={{ selectedItems: state, select, deselect, toggle, deselectAll, has, hasAll }}
    >
      {typeof children === "function"
        ? children({ selectedItems: state, select, deselect, toggle, deselectAll, has, hasAll })
        : children}
    </SelectedItemsContext.Provider>
  );
}

type SelectItemsAction = {
  type: "select";
  items: string[];
};

type DeSelectItemsAction = {
  type: "deselect";
  items: string[];
};

type DeselectAllItemsAction = {
  type: "deselectAll";
};

type ToggleItemsAction = {
  type: "toggle";
  items: string[];
};

type Action = SelectItemsAction | DeSelectItemsAction | ToggleItemsAction | DeselectAllItemsAction;

function selectedItemsReducer(state: Set<string>, action: Action) {
  switch (action.type) {
    case "select":
      return new Set([...state, ...action.items]);
    case "deselect":
      const newState = new Set(state);
      action.items.forEach((item) => {
        newState.delete(item);
      });
      return newState;
    case "toggle":
      const newSet = new Set(state);
      action.items.forEach((item) => {
        if (newSet.has(item)) {
          newSet.delete(item);
        } else {
          newSet.add(item);
        }
      });
      return newSet;
    case "deselectAll":
      return new Set<string>();
    default:
      return state;
  }
}

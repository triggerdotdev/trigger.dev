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
  maxSelectedItemCount,
  children,
}: {
  initialSelectedItems: string[];
  maxSelectedItemCount?: number;
  children: React.ReactNode | ((context: SelectedItemsContext) => React.ReactNode);
}) {
  const [state, dispatch] = useReducer(selectedItemsReducer, {
    items: new Set<string>(initialSelectedItems),
    maxSelectedItemCount,
  });

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

  const has = useCallback((item: string) => state.items.has(item), [state]);

  const hasAll = useCallback(
    (items: string[]) => items.every((item) => state.items.has(item)),
    [state]
  );

  return (
    <SelectedItemsContext.Provider
      value={{ selectedItems: state.items, select, deselect, toggle, deselectAll, has, hasAll }}
    >
      {typeof children === "function"
        ? children({
            selectedItems: state.items,
            select,
            deselect,
            toggle,
            deselectAll,
            has,
            hasAll,
          })
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

function selectedItemsReducer(
  state: { items: Set<string>; maxSelectedItemCount?: number },
  action: Action
) {
  switch (action.type) {
    case "select":
      const items = new Set([...state.items, ...action.items]);
      return { ...state, items: cappedSet(items, state.maxSelectedItemCount) };
    case "deselect":
      const newItems = new Set(state.items);
      action.items.forEach((item) => {
        newItems.delete(item);
      });
      return { ...state, items: cappedSet(newItems, state.maxSelectedItemCount) };
    case "toggle":
      let newSet = new Set(state.items);
      action.items.forEach((item) => {
        if (newSet.has(item)) {
          newSet.delete(item);
        } else {
          newSet.add(item);
        }
      });
      return { ...state, items: cappedSet(newSet, state.maxSelectedItemCount) };
    case "deselectAll":
      return { ...state, items: new Set<string>() };
    default:
      return state;
  }
}

function cappedSet(set: Set<string>, max?: number) {
  if (!max) {
    return set;
  }

  if (set.size <= max) {
    return set;
  }

  console.warn(`Selected items exceeded the maximum count of ${max}.`);

  return new Set([...set].slice(0, max));
}

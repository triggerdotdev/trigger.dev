import { Reducer, useReducer } from "react";

export type ListState<T> = {
  items: T[];
};

type AppendAction<T> = {
  type: "append";
  items: T[];
};

type UpdateAction<T> = {
  type: "update";
  index: number;
  item: T;
};

type DeleteAction<T> = {
  type: "delete";
  index: number;
};

type InsertAfter<T> = {
  type: "insertAfter";
  index: number;
  items: T[];
};

type Action<T> = AppendAction<T> | UpdateAction<T> | DeleteAction<T> | InsertAfter<T>;

function reducer<T>(state: ListState<T>, action: Action<T>): ListState<T> {
  switch (action.type) {
    case "append":
      return { items: [...state.items, ...action.items] };
    case "update":
      return {
        items: state.items.map((v, i) => (i === action.index ? action.item : v)),
      };
    case "delete":
      return { items: state.items.filter((_, i) => i !== action.index) };
    case "insertAfter":
      return {
        items: [
          ...state.items.slice(0, action.index + 1),
          ...action.items,
          ...state.items.slice(action.index + 1),
        ],
      };
  }
}

type HookReturn<T> = {
  items: T[];
  append: (items: T[]) => void;
  update: (index: number, item: T) => void;
  delete: (index: number) => void;
  insertAfter: (index: number, items: T[]) => void;
};

export function useList<T>(initialItems: T[]): HookReturn<T> {
  const [state, dispatch] = useReducer<Reducer<ListState<T>, Action<T>>>(reducer, {
    items: initialItems,
  });

  return {
    items: state.items,
    append: (items: T[]) => dispatch({ type: "append", items }),
    update: (index: number, item: T) => dispatch({ type: "update", index, item }),
    delete: (index: number) => dispatch({ type: "delete", index }),
    insertAfter: (index: number, items: T[]) => dispatch({ type: "insertAfter", index, items }),
  };
}

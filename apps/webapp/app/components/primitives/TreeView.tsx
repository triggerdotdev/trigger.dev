import { Key, useMemo } from "react";
import { TreeData } from "react-stately";
import { useTreeState } from "react-stately";

export type TreeViewProps<T extends object> = {
  tree: TreeData<T>;
  onExpandedChange?: (keys: Set<Key>) => any;
  disabledKeys?: Iterable<Key>;
  selectedKeys?: Iterable<Key> | "all";
};

export function TreeView<T extends object>({
  tree,
  onExpandedChange,
  disabledKeys,
  selectedKeys,
  ...others
}: TreeViewProps<T>) {
  const state = useTreeState({
    onExpandedChange,
    disabledKeys,
    selectedKeys,
    selectionMode: "single",
    disallowEmptySelection: true,
    ...others,
  });

  console.log({ tree, state });

  return (
    <div>
      {/* {state.collection.map((item) => (
        <TreeViewItem key={item.key} item={item} state={state} />
      ))} */}
    </div>
  );
}

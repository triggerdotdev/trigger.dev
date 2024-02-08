import { Fragment, Key } from "react";

export type TreeViewProps<TKey extends Key, TData> = {
  tree: FlatTree<TKey, TData>;
  renderNode: (params: { node: FlatTreeItem<TKey, TData> }) => React.ReactNode;
};

export function TreeView<TKey extends Key, TData>({
  tree,
  renderNode,
}: TreeViewProps<TKey, TData>) {
  console.log({ tree });

  return (
    <div>
      {tree.map((node) => (
        <Fragment key={node.id}>{renderNode({ node })}</Fragment>
      ))}
    </div>
  );
}

/** An actual tree structure with custom data */
export type Tree<TKey extends Key, TData> = {
  id: TKey;
  children?: Tree<TKey, TData>[];
  data: TData;
};

/** A tree but flattened so it can easily be used for DOM elements */
export type FlatTreeItem<TKey extends Key, TData> = {
  id: TKey;
  parentId: TKey | undefined;
  children: TKey[];
  hasChildren: boolean;
  /** The indentation level, the root is 0 */
  level: number;
  data: TData;
};

export type FlatTree<TKey extends Key, TData> = FlatTreeItem<TKey, TData>[];

export function flattenTree<TKey extends Key, TData>(
  tree: Tree<TKey, TData>
): FlatTree<TKey, TData> {
  const flatTree: FlatTree<TKey, TData> = [];

  function flattenNode(node: Tree<TKey, TData>, parentId: TKey | undefined, level: number) {
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

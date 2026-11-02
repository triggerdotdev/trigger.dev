import { describe, expect, it } from "vitest";
import type { Filter, FlatTree } from "~/components/primitives/TreeView/TreeView";
import type { NodesState, TreeState } from "~/components/primitives/TreeView/reducer";
import { applyFilterToState, concreteStateFromInput } from "~/components/primitives/TreeView/utils";

type Data = { message: string };
type Value = { text: string };

// The filter pass before it used parent and children maps, kept to check the output is the same.
function referenceFilter(
  tree: FlatTree<Data>,
  nodes: NodesState,
  filter: Filter<Data, Value>
): { filteredNodes: NodesState; visibleNodeIds: string[] } {
  const filteredOut = new Set(
    tree.filter((node) => !filter.fn(filter.value, node)).map((n) => n.id)
  );
  if (filteredOut.size === 0) {
    return {
      filteredNodes: nodes,
      visibleNodeIds: tree.filter((node) => nodes[node.id].visible).map((node) => node.id),
    };
  }
  const filteredNodes = { ...nodes };
  const selected = Object.entries(nodes).find(([, node]) => node.selected)?.[0];
  const visible = new Set<string>();
  const expanded = new Set<string>();
  for (const node of tree) {
    if (filteredOut.has(node.id)) continue;
    visible.add(node.id);
    if (node.hasChildren) expanded.add(node.id);
    let parentId = node.parentId;
    while (parentId) {
      visible.add(parentId);
      expanded.add(parentId);
      parentId = tree.find((other) => other.id === parentId)?.parentId;
    }
    if (node.hasChildren) {
      for (const child of tree.filter((other) => other.parentId === node.id)) {
        visible.add(child.id);
        if (child.hasChildren) expanded.add(child.id);
      }
    }
  }
  for (const node of tree) {
    if (!visible.has(node.id))
      filteredNodes[node.id] = { ...filteredNodes[node.id], visible: false };
  }
  for (const id of visible) filteredNodes[id] = { ...filteredNodes[id], visible: true };
  for (const id of visible) {
    if (!expanded.has(id)) filteredNodes[id] = { ...filteredNodes[id], expanded: false };
  }
  for (const id of expanded) filteredNodes[id] = { ...filteredNodes[id], expanded: true };
  if (selected) {
    filteredNodes[selected] = { ...filteredNodes[selected], selected: visible.has(selected) };
  }
  return {
    filteredNodes,
    visibleNodeIds: tree.filter((node) => filteredNodes[node.id].visible).map((node) => node.id),
  };
}

// Deterministic so a failure can be replayed.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

function randomTree(seed: number, size: number): FlatTree<Data> {
  const next = random(seed);
  const words = ["alpha", "beta", "gamma", "delta"];
  const items: { id: string; parentId?: string; level: number }[] = [{ id: "n0", level: 0 }];
  for (let i = 1; i < size; i++) {
    const parent = items[Math.floor(next() * items.length)];
    items.push({ id: `n${i}`, parentId: parent.id, level: parent.level + 1 });
  }
  // Depth first, as flattenTree emits it.
  const children = new Map<string, typeof items>();
  for (const item of items.slice(1)) {
    children.set(item.parentId!, [...(children.get(item.parentId!) ?? []), item]);
  }
  const tree: FlatTree<Data> = [];
  const visit = (item: (typeof items)[number]) => {
    tree.push({
      id: item.id,
      parentId: item.parentId,
      level: item.level,
      hasChildren: children.has(item.id),
      data: { message: `${words[Math.floor(next() * words.length)]} ${item.id}` },
    });
    for (const child of children.get(item.id) ?? []) visit(child);
  };
  visit(items[0]);
  return tree;
}

const byText = (text: string): Filter<Data, Value> => ({
  value: { text },
  fn: (value, node) => node.data.message.includes(value.text),
});

describe("applyFilterToState", () => {
  it("gives the same nodes and visible rows as the reference on random trees", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const tree = randomTree(seed, 60);
      const next = random(seed + 1_000);
      const collapsedIds = tree.filter(() => next() < 0.3).map((node) => node.id);
      const selectedId = tree[Math.floor(next() * tree.length)].id;
      const base = concreteStateFromInput({ tree, filter: undefined, selectedId, collapsedIds });

      for (const text of ["alpha", "n1", "zzz", "a", ""]) {
        const filter = byText(text);
        const actual: TreeState = applyFilterToState({ ...base, filter });
        const expected = referenceFilter(tree, base.nodes, filter);
        expect(actual.filteredNodes, `seed ${seed}, "${text}"`).toEqual(expected.filteredNodes);
        expect(actual.visibleNodeIds, `seed ${seed}, "${text}"`).toEqual(expected.visibleNodeIds);
      }
    }
  });

  it("opens every ancestor of a deep match, even when a sibling match opened some first", () => {
    const tree: FlatTree<Data> = [
      { id: "root", level: 0, hasChildren: true, data: { message: "root" } },
      { id: "a", parentId: "root", level: 1, hasChildren: true, data: { message: "a" } },
      { id: "a1", parentId: "a", level: 2, hasChildren: false, data: { message: "hit" } },
      { id: "b", parentId: "a", level: 2, hasChildren: true, data: { message: "b" } },
      { id: "b1", parentId: "b", level: 3, hasChildren: false, data: { message: "hit" } },
    ];
    const base = concreteStateFromInput({
      tree,
      filter: undefined,
      selectedId: undefined,
      collapsedIds: ["root", "a", "b"],
    });

    const state = applyFilterToState({ ...base, filter: byText("hit") });

    expect(state.visibleNodeIds).toEqual(["root", "a", "a1", "b", "b1"]);
    expect(["root", "a", "b"].map((id) => state.filteredNodes[id].expanded)).toEqual([
      true,
      true,
      true,
    ]);
  });
});

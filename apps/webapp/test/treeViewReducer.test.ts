import { describe, expect, it } from "vitest";
import type { FlatTree } from "~/components/primitives/TreeView/TreeView";
import { reducer, type Action, type TreeState } from "~/components/primitives/TreeView/reducer";
import { concreteStateFromInput } from "~/components/primitives/TreeView/utils";

type Data = Record<string, never>;

// root > a > (a1, a2 > a2x), b > b1, c
const tree: FlatTree<Data> = [
  { id: "root", level: 0, hasChildren: true, data: {} },
  { id: "a", parentId: "root", level: 1, hasChildren: true, data: {} },
  { id: "a1", parentId: "a", level: 2, hasChildren: false, data: {} },
  { id: "a2", parentId: "a", level: 2, hasChildren: true, data: {} },
  { id: "a2x", parentId: "a2", level: 3, hasChildren: false, data: {} },
  { id: "b", parentId: "root", level: 1, hasChildren: true, data: {} },
  { id: "b1", parentId: "b", level: 2, hasChildren: false, data: {} },
  { id: "c", parentId: "root", level: 1, hasChildren: false, data: {} },
];

const start = (collapsedIds: string[] = [], selectedId?: string): TreeState =>
  concreteStateFromInput({ tree, filter: undefined, selectedId, collapsedIds });
const apply = (state: TreeState, ...actions: Action[]) => actions.reduce(reducer, state);
const noScroll = { scrollToNode: false, scrollToNodeFn: () => {} };
const expanded = (state: TreeState) =>
  tree.filter((node) => node.hasChildren && state.nodes[node.id].expanded).map((node) => node.id);

describe("tree reducer", () => {
  it("collapses several nodes in one action, the same as one by one", () => {
    const one = apply(
      start(),
      { type: "COLLAPSE_NODE", payload: { id: "a" } },
      { type: "COLLAPSE_NODE", payload: { id: "b" } }
    );
    const bulk = apply(start(), { type: "COLLAPSE_NODES", payload: { ids: ["a", "b"] } });

    expect(bulk.nodes).toEqual(one.nodes);
    expect(bulk.visibleNodeIds).toEqual(["root", "a", "b", "c"]);
  });

  it("expands several nodes in one action, the same as one by one", () => {
    const collapsed = start(["a", "a2", "b"]);
    const one = apply(
      collapsed,
      { type: "EXPAND_NODE", payload: { id: "a", ...noScroll } },
      { type: "EXPAND_NODE", payload: { id: "b", ...noScroll } }
    );
    const bulk = apply(collapsed, { type: "EXPAND_NODES", payload: { ids: ["a", "b"] } });

    expect(bulk.nodes).toEqual(one.nodes);
    expect(bulk.visibleNodeIds).toEqual(["root", "a", "a1", "a2", "b", "b1", "c"]);
  });

  it("ignores ids that aren't in the tree", () => {
    const initial = start();
    expect(apply(initial, { type: "COLLAPSE_NODES", payload: { ids: ["nope"] } })).toBe(initial);
    expect(apply(initial, { type: "EXPAND_NODES", payload: { ids: [] } })).toBe(initial);
  });

  it("selects one node and clears the previous selection", () => {
    const state = apply(start([], "a1"), {
      type: "SELECT_NODE",
      payload: { id: "b1", ...noScroll },
    });

    expect(tree.filter((node) => state.nodes[node.id].selected).map((node) => node.id)).toEqual([
      "b1",
    ]);
    const cleared = apply(state, { type: "DESELECT_ALL_NODES" });
    expect(tree.some((node) => cleared.nodes[node.id].selected)).toBe(false);
  });

  it("expands and collapses by level and depth", () => {
    const all = start(["root", "a", "a2", "b"]);

    expect(expanded(apply(all, { type: "EXPAND_LEVEL", payload: { level: 1 } }))).toEqual([
      "root",
      "a",
      "b",
    ]);
    expect(expanded(apply(start(), { type: "COLLAPSE_LEVEL", payload: { level: 1 } }))).toEqual([
      "root",
      "a2",
    ]);
    expect(expanded(apply(all, { type: "EXPAND_ALL_BELOW_DEPTH", payload: { depth: 1 } }))).toEqual(
      ["a", "a2", "b"]
    );
    expect(
      apply(start(), { type: "COLLAPSE_ALL_BELOW_DEPTH", payload: { depth: 1 } }).visibleNodeIds
    ).toEqual(["root", "a", "b", "c"]);
  });
});

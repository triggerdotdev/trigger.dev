// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  flattenTree,
  useTree,
  type FlatTree,
  type FlatTreeItem,
  type Tree,
  type UseTreeStateOutput,
} from "~/components/primitives/TreeView/TreeView";

type Data = { kind: "session" | "run" | "span" };

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

const span = (id: string): Tree<Data> => ({ id, data: { kind: "span" } });
const run = (id: string, children: Tree<Data>[] = []): Tree<Data> => ({
  id,
  data: { kind: "run" },
  children,
});
const session = (runs: Tree<Data>[]) =>
  flattenTree<Data>({ id: "session", data: { kind: "session" }, children: runs });

type Options = Omit<
  Parameters<typeof useTree<Data, undefined>>[0],
  "tree" | "parentRef" | "estimatedRowHeight"
>;

function render(initialTree: FlatTree<Data>, options: Options = {}) {
  let output: UseTreeStateOutput | undefined;
  const parentRef = { current: null };

  function Harness({ tree, opts }: { tree: FlatTree<Data>; opts: Options }) {
    output = useTree<Data, undefined>({
      tree,
      parentRef,
      estimatedRowHeight: () => 32,
      ...opts,
    });
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { tree: initialTree, opts: options })));

  return {
    output: () => output!,
    rerender: (tree: FlatTree<Data>, opts: Options = options) =>
      act(() => root!.render(createElement(Harness, { tree, opts }))),
    act: (fn: (tree: UseTreeStateOutput) => void) => act(() => fn(output!)),
    key: (key: string) =>
      act(() =>
        output!.getTreeProps().onKeyDown?.({
          key,
          altKey: false,
          metaKey: false,
          defaultPrevented: false,
          preventDefault: () => {},
        } as unknown as React.KeyboardEvent<HTMLElement>)
      ),
  };
}

const isRun = (node: FlatTreeItem<Data>) => node.data.kind === "run";

describe("useTree isCollapsedByDefault", () => {
  it("starts matching nodes collapsed and hides their children", () => {
    const harness = render(session([run("r1", [span("s1")]), run("r2", [span("s2")])]), {
      isCollapsedByDefault: isRun,
    });
    const nodes = harness.output().nodes;

    expect(nodes.r1.expanded).toBe(false);
    expect(nodes.r2.expanded).toBe(false);
    expect(nodes.s1.visible).toBe(false);
    expect(nodes.session.expanded).toBe(true);
  });

  it("collapses nodes added later but keeps the user's expanded nodes open", () => {
    const options: Options = { isCollapsedByDefault: isRun };
    const harness = render(session([run("r1", [span("s1")])]), options);
    harness.act((tree) => tree.expandNode("r1", false));
    expect(harness.output().nodes.r1.expanded).toBe(true);

    harness.rerender(session([run("r1", [span("s1")]), run("r2", [span("s2")])]), options);
    const nodes = harness.output().nodes;

    expect(nodes.r1.expanded).toBe(true);
    expect(nodes.s1.visible).toBe(true);
    expect(nodes.r2.expanded).toBe(false);
    expect(nodes.s2.visible).toBe(false);
  });

  it("expands new nodes by default without the option", () => {
    const harness = render(session([run("r1", [span("s1")])]));
    harness.rerender(session([run("r1", [span("s1")]), run("r2", [span("s2")])]));

    expect(harness.output().nodes.r2.expanded).toBe(true);
  });
});

describe("useTree selection", () => {
  it("keeps a selected node collapsed when the tree grows", () => {
    const harness = render(session([run("r1", [span("s1")])]));
    harness.act((tree) => tree.selectNode("r1", false));
    harness.act((tree) => tree.collapseNode("r1"));

    harness.rerender(session([run("r1", [span("s1"), span("s2")])]));
    const nodes = harness.output().nodes;

    expect(nodes.r1.selected).toBe(true);
    expect(nodes.r1.expanded).toBe(false);
    expect(nodes.s2.visible).toBe(false);
  });

  it("keeps a collapsed parent of the selection collapsed when the tree grows", () => {
    const harness = render(session([run("r1", [span("s1")])]));
    harness.act((tree) => tree.selectNode("s1", false));
    harness.act((tree) => tree.collapseNode("r1"));

    harness.rerender(session([run("r1", [span("s1"), span("s2")])]));
    const nodes = harness.output().nodes;

    expect(nodes.s1.selected).toBe(true);
    expect(nodes.r1.expanded).toBe(false);
    expect(nodes.s1.visible).toBe(false);
  });

  it("opens the selection's parents on first render, even when collapsed by default", () => {
    const harness = render(session([run("r1", [span("s1")]), run("r2", [span("s2")])]), {
      selectedId: "s1",
      isCollapsedByDefault: isRun,
    });
    const nodes = harness.output().nodes;

    expect(nodes.r1.expanded).toBe(true);
    expect(nodes.s1.visible).toBe(true);
    expect(nodes.r2.expanded).toBe(false);
  });
});

describe("useTree canExpand", () => {
  it("lets a node with no children collapse from the keyboard", () => {
    const harness = render(session([run("r1"), run("r2")]), { canExpand: isRun });
    harness.act((tree) => tree.selectNode("r1", false));

    harness.key("ArrowLeft");

    expect(harness.output().nodes.r1.expanded).toBe(false);
    expect(harness.output().selected).toBe("r1");
  });

  it("moves to the parent instead when the node can't expand", () => {
    const harness = render(session([run("r1"), run("r2")]));
    harness.act((tree) => tree.selectNode("r1", false));

    harness.key("ArrowLeft");

    expect(harness.output().selected).toBe("session");
  });
});

describe("useTree onExpandedChange", () => {
  it("reports single-node expand and collapse, and skips no-op changes", () => {
    const calls: Array<[string, boolean]> = [];
    const harness = render(session([run("r1", [span("s1")])]), {
      onExpandedChange: (id, expanded) => calls.push([id, expanded]),
    });

    harness.act((tree) => tree.toggleExpandNode("r1", false));
    harness.act((tree) => tree.collapseNode("r1"));
    harness.act((tree) => tree.expandNode("r1", false));
    harness.act((tree) => tree.expandNode("r1", false));

    expect(calls).toEqual([
      ["r1", false],
      ["r1", true],
    ]);
  });

  it("reports keyboard collapse", () => {
    const calls: Array<[string, boolean]> = [];
    const harness = render(session([run("r1", [span("s1")])]), {
      onExpandedChange: (id, expanded) => calls.push([id, expanded]),
    });
    harness.act((tree) => tree.selectNode("r1", false));

    harness.key("ArrowLeft");

    expect(calls).toEqual([["r1", false]]);
  });
});

describe("useTree structureKey", () => {
  // Same node count, different nodes: a placeholder row replaced by the real one.
  const before = session([run("r1", [span("placeholder")])]);
  const after = session([run("r1", [span("s1")])]);

  // Without a key, state only rebuilds when the node count changes (cheap for very large trees).
  it("keeps the old state for a same-length change when no key is given", () => {
    const harness = render(before);
    harness.rerender(after);

    expect(harness.output().nodes.s1).toBeUndefined();
  });

  it("rebuilds when the key changes", () => {
    const harness = render(before, { structureKey: 1 });
    harness.rerender(after, { structureKey: 2 });
    const nodes = harness.output().nodes;

    expect(nodes.s1?.visible).toBe(true);
    expect(nodes.placeholder).toBeUndefined();
  });
});

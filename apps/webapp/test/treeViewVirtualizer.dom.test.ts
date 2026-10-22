// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import {
  flattenTree,
  useTree,
  type FlatTreeItem,
  type UseTreeStateOutput,
} from "~/components/primitives/TreeView/TreeView";

type Data = { title: string };

const tree = flattenTree<Data>({
  id: "root",
  data: { title: "root" },
  children: [
    {
      id: "a",
      data: { title: "a" },
      children: [
        { id: "a1", data: { title: "a1" } },
        { id: "a2", data: { title: "a2" } },
      ],
    },
    { id: "b", data: { title: "b" } },
  ],
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function render() {
  let output: UseTreeStateOutput | undefined;
  const estimates = new Map<number, string>();
  const parentRef = { current: null };
  const estimatedRowHeight = ({ node, index }: { node: FlatTreeItem<Data>; index: number }) => {
    estimates.set(index, node.id);
    return 32;
  };
  let filterCalls = 0;
  const filter = {
    value: "match-all",
    fn: () => {
      filterCalls++;
      return true;
    },
  };

  function Harness({ tick: _tick }: { tick: number }) {
    output = useTree({ tree, parentRef, estimatedRowHeight, filter });
    return null;
  }

  let tick = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { tick })));

  return {
    output: () => output!,
    estimates,
    filterCalls: () => filterCalls,
    rerender: () => {
      tick++;
      act(() => root!.render(createElement(Harness, { tick })));
    },
  };
}

describe("useTree virtualizer options", () => {
  it("keeps getItemKey identity across re-renders with unchanged rows", () => {
    const harness = render();
    const before = harness.output().virtualizer.options.getItemKey;

    harness.rerender();

    expect(harness.output().virtualizer.options.getItemKey).toBe(before);
  });

  it("changes getItemKey when the visible rows change", () => {
    const harness = render();
    const before = harness.output().virtualizer.options.getItemKey;

    act(() => harness.output().collapseNode("a"));

    expect(harness.output().virtualizer.options.getItemKey).not.toBe(before);
  });

  it("doesn't rebuild the initial tree state on re-render", () => {
    const harness = render();
    const before = harness.filterCalls();

    harness.rerender();

    expect(harness.filterCalls()).toBe(before);
  });

  it("estimates each row from the node shown in that row", () => {
    const harness = render();
    act(() => harness.output().collapseNode("a"));
    harness.estimates.clear();

    harness.output().virtualizer.getTotalSize();

    expect([...harness.estimates.entries()].sort(([a], [b]) => a - b)).toEqual([
      [0, "root"],
      [1, "a"],
      [2, "b"],
    ]);
  });
});

// @vitest-environment jsdom
import { createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flattenTree, TreeView, useTree } from "~/components/primitives/TreeView/TreeView";

type Data = { title: string };

// root > a (collapsed) > a1, a2; b
const tree = flattenTree<Data>({
  id: "root",
  data: { title: "root" },
  children: [
    {
      id: "a",
      data: { title: "a" },
      children: [
        { id: "a1", data: { title: "hit a1" } },
        { id: "a2", data: { title: "a2" } },
      ],
    },
    { id: "b", data: { title: "b" } },
  ],
});

// The virtualizer only renders rows that fit its scroll element, which jsdom sizes at 0.
const sizes = ["offsetHeight", "offsetWidth", "clientHeight", "clientWidth"] as const;
const originals = sizes.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
const originalRect = HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  for (const key of sizes) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => 800 });
  }
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 800, height: 800, top: 0, left: 0, right: 800, bottom: 800, x: 0, y: 0 }) as DOMRect;
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  sizes.forEach((key, i) => {
    if (originals[i]) Object.defineProperty(HTMLElement.prototype, key, originals[i]!);
  });
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function Harness({ text }: { text: string }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const tree_ = useTree<Data, string>({
    tree,
    parentRef,
    estimatedRowHeight: () => 32,
    collapsedIds: ["a"],
    filter: {
      value: text || undefined,
      fn: (value, node) => node.data.title.includes(value),
    },
  });
  return createElement(TreeView<Data>, {
    tree,
    nodes: tree_.nodes,
    virtualizer: tree_.virtualizer,
    parentRef,
    staticRowHeight: true,
    getTreeProps: tree_.getTreeProps,
    getNodeProps: tree_.getNodeProps,
    renderNode: ({ node }) => createElement("span", { "data-row": node.id }, node.data.title),
  });
}

const rendered = () =>
  [...container!.querySelectorAll("[data-row]")].map((row) => row.getAttribute("data-row"));

describe("TreeView with a filter", () => {
  it("renders matches inside a collapsed node", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(Harness, { text: "" })));
    expect(rendered()).toEqual(["root", "a", "b"]);

    act(() => root!.render(createElement(Harness, { text: "hit" })));
    expect(rendered()).toEqual(["root", "a", "a1"]);
  });
});

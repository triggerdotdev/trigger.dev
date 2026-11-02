// @vitest-environment jsdom
// Unit test: keyboard selection in the shared tree primitive is stable, reused behaviour.
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

type Data = { kind: "session" | "run" | "label" };

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

const node = (id: string, kind: Data["kind"]): Tree<Data> => ({ id, data: { kind } });

// session, label, run1, label2, label3, run2, label4
const tree = flattenTree<Data>({
  id: "session",
  data: { kind: "session" },
  children: [
    node("label1", "label"),
    node("run1", "run"),
    node("label2", "label"),
    node("label3", "label"),
    node("run2", "run"),
    node("label4", "label"),
  ],
});

const notLabel = (item: FlatTreeItem<Data>) => item.data.kind !== "label";

function render(
  canSelect?: (item: FlatTreeItem<Data>) => boolean,
  initialTree: FlatTree<Data> = tree
) {
  let output: UseTreeStateOutput | undefined;
  const parentRef = { current: null };

  function Harness() {
    output = useTree<Data, undefined>({
      tree: initialTree,
      parentRef,
      estimatedRowHeight: () => 32,
      canSelect,
    });
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness)));

  return {
    selected: () => output!.selected,
    select: (id: string) => act(() => output!.selectNode(id, false)),
    collapse: (id: string) => act(() => output!.collapseNode(id)),
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

describe("useTree canSelect", () => {
  it("skips rows that can't be selected when moving down and up", () => {
    const view = render(notLabel);
    view.select("session");

    view.key("ArrowDown");
    expect(view.selected()).toBe("run1");
    view.key("ArrowDown");
    expect(view.selected()).toBe("run2");
    view.key("ArrowDown");
    expect(view.selected()).toBe("run2");

    view.key("ArrowUp");
    expect(view.selected()).toBe("run1");
    view.key("ArrowUp");
    expect(view.selected()).toBe("session");
    view.key("ArrowUp");
    expect(view.selected()).toBe("session");
  });

  it("skips them for Home and End", () => {
    const labelFirst = flattenTree<Data>({
      id: "root-label",
      data: { kind: "label" },
      children: [node("run1", "run"), node("label9", "label")],
    });
    const view = render(notLabel, labelFirst);
    view.select("run1");

    view.key("End");
    expect(view.selected()).toBe("run1");
    view.key("Home");
    expect(view.selected()).toBe("run1");
  });

  it("starts at the first selectable row when nothing is selected", () => {
    const labelFirst = flattenTree<Data>({
      id: "root-label",
      data: { kind: "label" },
      children: [node("run1", "run")],
    });
    const view = render(notLabel, labelFirst);

    view.key("ArrowDown");
    expect(view.selected()).toBe("run1");
  });

  it("starts again from the top when the selected row is hidden", () => {
    const nested = flattenTree<Data>({
      id: "session",
      data: { kind: "session" },
      children: [
        node("label1", "label"),
        { id: "run1", data: { kind: "run" }, children: [node("span1", "run")] },
        node("run2", "run"),
      ],
    });
    const view = render(notLabel, nested);
    view.select("span1");
    view.collapse("run1");

    view.key("ArrowUp");
    expect(view.selected()).toBe("session");
  });

  it("skips parents that can't be selected on ArrowLeft", () => {
    const nested = flattenTree<Data>({
      id: "session",
      data: { kind: "session" },
      children: [
        {
          id: "group",
          data: { kind: "label" },
          children: [{ id: "run1", data: { kind: "run" }, children: [] }],
        },
      ],
    });
    const view = render(notLabel, nested);
    view.select("run1");

    view.key("ArrowLeft");
    expect(view.selected()).toBe("session");
  });

  it("moves through every row without canSelect", () => {
    const view = render();
    view.select("session");

    view.key("ArrowDown");
    expect(view.selected()).toBe("label1");
    view.key("ArrowDown");
    expect(view.selected()).toBe("run1");
    view.key("End");
    expect(view.selected()).toBe("label4");
    view.key("ArrowUp");
    expect(view.selected()).toBe("run2");
  });
});

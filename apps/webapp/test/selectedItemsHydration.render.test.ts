// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SelectedItemsProvider,
  useSelectedItems,
  useTickedBeforeHydration,
} from "~/components/primitives/SelectedItemsProvider";

const ids = ["a", "b", "c"];

function List() {
  const { has, select, toggle, selectedItems } = useSelectedItems();
  const scopeRef = useRef<HTMLDivElement>(null);
  useTickedBeforeHydration(scopeRef, select);
  return createElement(
    "div",
    { ref: scopeRef },
    createElement("output", null, [...selectedItems].join(",")),
    ids.map((id) =>
      createElement("input", {
        key: id,
        type: "checkbox",
        value: id,
        checked: has(id),
        onChange: () => toggle(id),
      })
    )
  );
}

function Page() {
  return createElement(SelectedItemsProvider, { initialSelectedItems: [] }, createElement(List));
}

describe("useTickedBeforeHydration", () => {
  // Catches: checkboxes ticked before the page hydrates showing as ticked while nothing is
  // selected, then being unticked by the first render after hydration.
  it("selects the checkboxes that were ticked before hydration", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(createElement(Page));
    document.body.appendChild(container);
    const boxes = () => [...container.querySelectorAll("input")];

    // The server's HTML is on the page and React hasn't hydrated it: these change only the DOM.
    boxes()[0].click();
    boxes()[2].click();

    await act(async () => {
      hydrateRoot(container, createElement(Page));
    });
    expect(container.querySelector("output")?.textContent).toBe("a,c");

    // A tick after hydration re-renders every box: the early ones stay ticked.
    await act(async () => boxes()[1].click());
    expect(container.querySelector("output")?.textContent).toBe("a,c,b");
    expect(boxes().map((box) => box.checked)).toEqual([true, true, true]);
  });
});

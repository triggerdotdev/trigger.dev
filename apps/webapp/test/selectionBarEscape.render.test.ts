// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { SelectionBar } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/SelectionBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const onClear = vi.fn();
// As the route does: the focus goes to the header's box.
const restoreFocus = vi.fn(() => container.querySelector<HTMLInputElement>("#header-box")!.focus());

beforeEach(async () => {
  onClear.mockReset();
  restoreFocus.mockClear();
  container = document.createElement("div");
  container.innerHTML =
    '<input type="checkbox" /><input type="search" /><input type="checkbox" id="header-box" />';
  document.body.appendChild(container);
  const mount = document.createElement("div");
  container.appendChild(mount);
  root = createRoot(mount);
  await act(async () => {
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(SelectionBar, {
            count: 2,
            label: "2 selected",
            onClear,
            restoreFocus,
            actions: [],
          })
        )
      )
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function pressEscapeOn(element: HTMLElement) {
  element.focus();
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

describe("SelectionBar Escape", () => {
  // Catches: Escape doing nothing after a row was ticked with the mouse, because the ticked
  // checkbox keeps the focus and counted as a field the user types in.
  it("clears the selection while a checkbox has the focus", () => {
    pressEscapeOn(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("leaves the selection alone while the focus is in a text field", () => {
    pressEscapeOn(container.querySelector<HTMLInputElement>('input[type="search"]')!);
    expect(onClear).not.toHaveBeenCalled();
  });

  it("leaves the selection alone while a dialog is open", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    pressEscapeOn(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    dialog.remove();
    expect(onClear).not.toHaveBeenCalled();
  });
});

describe("SelectionBar focus", () => {
  function clearButton() {
    return [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Clear"))!;
  }

  // Catches: the focus falling to the page when clearing from the keyboard removes the bar under it.
  it("moves the focus into the list when Escape clears with the focus on the bar", () => {
    pressEscapeOn(clearButton());
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe("header-box");
  });

  // jsdom's :focus-visible follows the last event, so this click acts as a mouse click.
  it("leaves the focus alone when Clear is clicked with the mouse", () => {
    clearButton().focus();
    clearButton().click();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(restoreFocus).not.toHaveBeenCalled();
  });

  it("leaves the focus where it is when it isn't on the bar", () => {
    const rowBox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    pressEscapeOn(rowBox);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(restoreFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowBox);
  });
});

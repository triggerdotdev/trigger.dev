// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { ModeToggle } from "./DashboardAgentHeader";

function withProviders(children: React.ReactNode) {
  return createElement(
    OperatingSystemContextProvider,
    { platform: "mac" },
    createElement(ShortcutsProvider, null, children)
  );
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
  }
  container?.remove();
  container = undefined;
  root = undefined;
});

function renderToggle(mode: "floating" | "rightPanel" | "fullscreen", onModeChange: () => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(withProviders(createElement(ModeToggle, { mode, onModeChange })));
  });
  return container;
}

// Row-reverse layout keeps the trigger as the first button in DOM order.
function getTrigger(el: HTMLElement) {
  return el.querySelectorAll("button")[0] as HTMLButtonElement;
}

function expandToggle(el: HTMLElement) {
  const trigger = getTrigger(el);
  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ModeToggle", () => {
  it("collapses on Escape without changing mode, and marks the event handled", () => {
    const onModeChange = vi.fn();
    const el = renderToggle("floating", onModeChange);
    expandToggle(el);
    expect(getTrigger(el).getAttribute("aria-expanded")).toBe("true");

    // cancelable: true, like a real native keydown; otherwise preventDefault() is a no-op.
    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(escapeEvent);
    });

    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(getTrigger(el).getAttribute("aria-expanded")).toBe("false");
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("collapses when mode changes externally", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onModeChange = vi.fn();
    act(() => {
      root!.render(withProviders(createElement(ModeToggle, { mode: "floating", onModeChange })));
    });
    expandToggle(container);
    expect(getTrigger(container).getAttribute("aria-expanded")).toBe("true");

    act(() => {
      root!.render(withProviders(createElement(ModeToggle, { mode: "fullscreen", onModeChange })));
    });

    expect(getTrigger(container).getAttribute("aria-expanded")).toBe("false");
  });
});

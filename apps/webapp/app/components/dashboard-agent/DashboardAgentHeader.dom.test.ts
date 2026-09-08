// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
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

type Mode = "floating" | "rightPanel" | "fullscreen";

/**
 * Controlled, like `DashboardAgent`: a selection feeds the new mode straight back in, so
 * a second key press starts from where the first one left it.
 */
function renderControlledToggle(initial: Mode) {
  const changes: Mode[] = [];
  let mode = initial;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const draw = () => {
    act(() => {
      root!.render(withProviders(createElement(ModeToggle, { mode, onModeChange })));
    });
  };
  function onModeChange(next: Mode) {
    changes.push(next);
    mode = next;
    draw();
  }
  draw();
  return {
    el: container,
    changes,
    setMode(next: Mode) {
      mode = next;
      draw();
    },
  };
}

function renderToggle(mode: Mode, onModeChange: (next: Mode) => void) {
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

function radios(el: HTMLElement) {
  return [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

/** Expanded is when there is a choice on screen — i.e. a radio group. */
function isExpanded(el: HTMLElement) {
  return el.querySelector('[role="radiogroup"]') !== null;
}

function expandToggle(el: HTMLElement) {
  const trigger = getTrigger(el);
  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ModeToggle", () => {
  it("collapses on Escape without changing mode, and marks the event handled", () => {
    const changes: Mode[] = [];
    const el = renderToggle("floating", (next) => changes.push(next));
    expandToggle(el);
    expect(isExpanded(el)).toBe(true);

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
    expect(isExpanded(el)).toBe(false);
    expect(changes).toEqual([]);
  });

  it("collapses when mode changes externally", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const changes: Mode[] = [];
    const onModeChange = (next: Mode) => changes.push(next);
    act(() => {
      root!.render(withProviders(createElement(ModeToggle, { mode: "floating", onModeChange })));
    });
    expandToggle(container);
    expect(isExpanded(container)).toBe(true);

    act(() => {
      root!.render(withProviders(createElement(ModeToggle, { mode: "fullscreen", onModeChange })));
    });

    expect(isExpanded(container)).toBe(false);
    expect(changes).toEqual([]);
  });
});

describe("ModeToggle's radio semantics", () => {
  it("is a plain disclosure button while collapsed, with no radio in sight", () => {
    const el = renderToggle("rightPanel", () => {});

    expect(isExpanded(el)).toBe(false);
    expect(radios(el)).toEqual([]);
    const trigger = getTrigger(el);
    expect(trigger.getAttribute("aria-haspopup")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("Right panel");
  });

  it("becomes a labelled radio group once expanded, with the current mode checked", () => {
    const el = renderToggle("rightPanel", () => {});
    expandToggle(el);

    expect(el.querySelector('[role="radiogroup"]')!.getAttribute("aria-label")).toBe(
      "Chat display mode"
    );
    const all = radios(el);
    expect(all).toHaveLength(3);
    const checked = all.filter((radio) => radio.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.getAttribute("aria-label")).toBe("Right panel");
  });

  it("drops aria-expanded from the checked radio, where it isn't allowed", () => {
    const el = renderToggle("floating", () => {});
    expandToggle(el);

    const trigger = getTrigger(el);
    expect(trigger.getAttribute("role")).toBe("radio");
    expect(trigger.getAttribute("aria-expanded")).toBeNull();
    expect(trigger.getAttribute("aria-haspopup")).toBeNull();
  });

  it("keeps only the checked option in the tab order", () => {
    const el = renderToggle("floating", () => {});
    expandToggle(el);

    for (const radio of radios(el)) {
      const checked = radio.getAttribute("aria-checked") === "true";
      expect(radio.tabIndex).toBe(checked ? 0 : -1);
    }
  });

  function arrow(el: HTMLElement, key: string) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => {
      getTrigger(el).dispatchEvent(event);
    });
    return event;
  }

  it("moves the selection the way the row reads, which runs right to left", () => {
    const view = renderControlledToggle("rightPanel");
    expandToggle(view.el);

    // The row is `flex-row-reverse`, so on screen the modes run fullscreen, rightPanel,
    // floating from left to right.
    arrow(view.el, "ArrowRight");
    expect(view.changes).toEqual(["floating"]);

    expandToggle(view.el);
    arrow(view.el, "ArrowLeft");

    expect(view.changes).toEqual(["floating", "rightPanel"]);
  });

  it("wraps around at the ends, so the group is a loop", () => {
    const view = renderControlledToggle("floating");
    expandToggle(view.el);

    arrow(view.el, "ArrowRight");

    expect(view.changes).toEqual(["fullscreen"]);
  });

  it("takes the arrow key, so the panel behind it doesn't also scroll", () => {
    const el = renderToggle("floating", () => {});
    expandToggle(el);

    expect(arrow(el, "ArrowRight").defaultPrevented).toBe(true);
  });

  it("ignores arrow keys while collapsed, where there is nothing to move through", () => {
    const view = renderControlledToggle("floating");

    const event = arrow(view.el, "ArrowRight");

    expect(view.changes).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});

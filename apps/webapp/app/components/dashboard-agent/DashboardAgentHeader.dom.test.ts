// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { ModeMenu, ModeMenuOptions, useModeMenu } from "./DashboardAgentHeader";

/**
 * The layout menu's popover is never opened here: Radix positions it with a floating-ui build
 * that needs `ResizeObserver`, which jsdom doesn't have, and tests don't stub it. The menu's rows,
 * and the hook behind the menu and its trigger's tooltip, are each tested on their own instead,
 * driven the way the popover drives them. The trigger is tested closed. What's left is Radix's
 * own: Escape and outside clicks closing it, and focus going back to the trigger.
 */

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

function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(withProviders(element));
  });
  return container;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("ModeMenu", () => {
  it("names the current layout on its trigger, and starts closed", () => {
    const el = render(createElement(ModeMenu, { mode: "rightPanel", onModeChange: () => {} }));
    const trigger = el.querySelector('button[aria-haspopup="dialog"]')!;

    expect(trigger.getAttribute("aria-label")).toBe("Change layout, currently Right panel");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("ModeMenuOptions", () => {
  function renderOptions(mode: Mode) {
    const changes: Mode[] = [];
    let done = 0;
    const el = render(
      createElement(ModeMenuOptions, {
        mode,
        onModeChange: (next: Mode) => changes.push(next),
        onDone: () => {
          done += 1;
        },
      })
    );
    const item = (label: string) =>
      [...el.querySelectorAll("button")].find((b) => b.textContent === label)!;
    return { el, changes, item, doneCount: () => done };
  }

  it("lists every layout, in order", () => {
    const { el } = renderOptions("rightPanel");

    expect([...el.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Floating panel",
      "Right panel",
      "Full page",
    ]);
  });

  it("checks the current layout alone", () => {
    const { item } = renderOptions("rightPanel");

    // Every row leads with its layout's icon; only the current one also ends with the check.
    const icons = (label: string) => item(label).querySelectorAll("svg").length;
    expect(icons("Right panel")).toBe(2);
    expect(icons("Floating panel")).toBe(1);
    expect(icons("Full page")).toBe(1);
  });

  it("reports a different layout picked, and finishes", () => {
    const view = renderOptions("floating");

    click(view.item("Full page"));

    expect(view.changes).toEqual(["fullscreen"]);
    expect(view.doneCount()).toBe(1);
  });

  it("finishes without reporting anything when the current layout is picked again", () => {
    const view = renderOptions("floating");

    click(view.item("Floating panel"));

    expect(view.changes).toEqual([]);
    expect(view.doneCount()).toBe(1);
  });
});

describe("useModeMenu", () => {
  // The hook `ModeMenu` runs, its guards on a real tooltip's trigger, with a plain button for each
  // way the popover changes the menu. The tooltip is held shut so it never needs positioning (see
  // above); what's checked is whether it asks to open.
  function Harness({
    mode,
    onTooltipOpenChange,
  }: {
    mode: Mode;
    onTooltipOpenChange: (open: boolean) => void;
  }) {
    const menu = useModeMenu(mode);
    const button = (action: string, onClick: () => void) =>
      createElement("button", { type: "button", "data-action": action, onClick });
    return createElement(
      "div",
      { "data-menu": String(menu.isOpen) },
      createElement(SimpleTooltip, {
        asChild: true,
        open: false,
        onOpenChange: onTooltipOpenChange,
        delayDuration: 0,
        content: "Change layout",
        button: createElement("button", {
          type: "button",
          "data-trigger": "",
          ...menu.tooltipGuards,
        }),
      }),
      // The trigger clicked.
      button("open", () => menu.setOpen(true)),
      // A click outside the menu.
      button("dismiss", () => menu.setOpen(false)),
      // A row picked, or Escape.
      button("close-from-inside", menu.closeFromInside)
    );
  }

  function renderHarness(mode: Mode) {
    const tooltipRequests: boolean[] = [];
    const onTooltipOpenChange = (open: boolean) => {
      tooltipRequests.push(open);
    };
    const el = render(createElement(Harness, { mode, onTooltipOpenChange }));
    const trigger = () => el.querySelector<HTMLButtonElement>("[data-trigger]")!;
    return {
      tooltipRequests,
      press: (action: string) => click(el.querySelector(`[data-action="${action}"]`)!),
      rerender: (next: Mode) => {
        act(() => {
          root!.render(withProviders(createElement(Harness, { mode: next, onTooltipOpenChange })));
        });
      },
      isMenuOpen: () => el.querySelector<HTMLElement>("[data-menu]")!.dataset.menu === "true",
      focusTrigger: () => act(() => trigger().focus()),
      blurTrigger: () => act(() => trigger().blur()),
      hoverTrigger: async () => {
        act(() => {
          trigger().dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
        });
        // Hover waits out the tooltip's delay, 0 here but still a timer.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      },
    };
  }

  it("closes when the layout changes from outside the menu, e.g. a route leaving Full page", () => {
    const view = renderHarness("fullscreen");
    view.press("open");
    expect(view.isMenuOpen()).toBe(true);

    view.rerender("floating");

    expect(view.isMenuOpen()).toBe(false);
  });

  it("stays open while the layout holds", () => {
    const view = renderHarness("floating");
    view.press("open");

    view.rerender("floating");

    expect(view.isMenuOpen()).toBe(true);
  });

  it("leaves the tooltip to open on focus and on hover, as usual", async () => {
    const view = renderHarness("floating");

    view.focusTrigger();
    expect(view.tooltipRequests).toEqual([true]);

    view.blurTrigger();
    await view.hoverTrigger();
    expect(view.tooltipRequests).toEqual([true, true]);
  });

  it("closes from inside without the tooltip that focus coming back would open, then allows it", () => {
    const view = renderHarness("floating");
    view.press("open");

    view.press("close-from-inside");
    expect(view.isMenuOpen()).toBe(false);
    view.focusTrigger();
    expect(view.tooltipRequests).toEqual([]);

    view.blurTrigger();
    view.focusTrigger();
    expect(view.tooltipRequests).toEqual([true]);
  });

  it("skips no tooltip after a click outside, which leaves focus where it lands", () => {
    const view = renderHarness("floating");
    view.press("open");

    view.press("dismiss");
    view.focusTrigger();

    expect(view.tooltipRequests).toEqual([true]);
  });

  it("keeps the tooltip from asking to open over the open menu, so none shows once it closes", async () => {
    const view = renderHarness("floating");
    view.press("open");

    await view.hoverTrigger();
    expect(view.tooltipRequests).toEqual([]);

    view.press("dismiss");
    await view.hoverTrigger();
    expect(view.tooltipRequests).toEqual([true]);
  });
});

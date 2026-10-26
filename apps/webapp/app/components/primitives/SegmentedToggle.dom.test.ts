// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedToggle } from "./SegmentedToggle";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }) as unknown as MediaQueryList
  );
}

const segments = [
  { value: "a", label: "Alpha", icon: createElement("i") },
  { value: "b", label: "Beta", icon: createElement("i") },
];

function Harness({ disabled }: { disabled?: boolean }) {
  const [value, setValue] = useState("a");
  return createElement(SegmentedToggle, { segments, value, onChange: setValue, disabled });
}

function mount({ reduced = true, disabled = false } = {}) {
  stubReducedMotion(reduced);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { disabled })));
  const radio = (label: string) =>
    Array.from(container!.querySelectorAll('[role="radio"]')).find((b) =>
      b.getAttribute("aria-label")?.startsWith(label)
    ) as HTMLButtonElement;
  const label = (name: string) => radio(name).querySelector("[data-toggle-label]") as HTMLElement;
  return { radio, label };
}

describe("SegmentedToggle", () => {
  it("renders the label only on the active segment, statically", () => {
    const { radio, label } = mount();
    expect(radio("Alpha").getAttribute("aria-checked")).toBe("true");
    expect(label("Alpha").textContent).toBe("Alpha");
    expect(label("Alpha").getAttribute("style")).toBeNull();
    expect(label("Beta")).toBeNull();
    expect(radio("Beta").getAttribute("aria-label")).toBe("Beta");
  });

  it("switches on click and moves the label", () => {
    const { radio, label } = mount();
    act(() => radio("Beta").click());
    expect(radio("Beta").getAttribute("aria-checked")).toBe("true");
    expect(radio("Alpha").getAttribute("aria-checked")).toBe("false");
    expect(label("Beta").textContent).toBe("Beta");
    expect(label("Alpha")).toBeNull();
  });

  it("keeps only the active segment in the tab order", () => {
    const { radio } = mount();
    expect(radio("Alpha").tabIndex).toBe(0);
    expect(radio("Beta").tabIndex).toBe(-1);
    act(() => radio("Beta").click());
    expect(radio("Alpha").tabIndex).toBe(-1);
    expect(radio("Beta").tabIndex).toBe(0);
  });

  it("reports motion mode from prefers-reduced-motion", () => {
    mount({ reduced: true });
    const group = () => container!.querySelector('[role="radiogroup"]')!;
    expect(group().getAttribute("data-motion")).toBe("reduced");
    expect(group().getAttribute("data-duration")).toBe("0");
    act(() => root!.unmount());
    container!.remove();
    mount({ reduced: false });
    expect(group().getAttribute("data-motion")).toBe("full");
    expect(group().getAttribute("data-duration")).toBe("0.2");
  });

  it("disables every radio", () => {
    const { radio } = mount({ disabled: true });
    expect(radio("Alpha").disabled).toBe(true);
    expect(radio("Beta").disabled).toBe(true);
  });

  it("moves selection with arrow keys", () => {
    const { radio } = mount();
    act(() => {
      radio("Alpha").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
    });
    expect(radio("Beta").getAttribute("aria-checked")).toBe("true");
  });
});

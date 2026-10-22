// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AgentManualToggle } from "./creationControls";

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

function Harness({ onChange }: { onChange: (manual: boolean) => void }) {
  const [manual, setManual] = useState(false);
  return createElement(AgentManualToggle, {
    manual,
    onChange: (next: boolean) => {
      onChange(next);
      setManual(next);
    },
  });
}

function mount(onChange = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, createElement(Harness, { onChange }))
      )
    )
  );
  const segment = (word: string) =>
    Array.from(container!.querySelectorAll('[role="radio"]')).find((b) =>
      b.getAttribute("aria-label")?.startsWith(word)
    )!;
  const activeLabels = () =>
    Array.from(container!.querySelectorAll("[data-toggle-label]")).map((el) => el.textContent);
  return { onChange, segment, activeLabels };
}

describe("AgentManualToggle", () => {
  it("shows the label only on the active mode's label, naming both segments", () => {
    stubReducedMotion(true);
    const { segment, activeLabels } = mount();
    expect(activeLabels()).toEqual(["Agent"]);
    expect(segment("Agent").getAttribute("aria-checked")).toBe("true");
    expect(segment("Manual").getAttribute("aria-checked")).toBe("false");
    expect(segment("Manual").querySelector("[data-toggle-label]")).toBeNull();
    expect(segment("Manual").getAttribute("aria-label")).toContain("Manual");
  });

  it("switches on the inactive segment and swaps the visible label", () => {
    stubReducedMotion(true);
    const { segment, activeLabels, onChange } = mount();
    act(() => segment("Manual").click());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(segment("Manual").getAttribute("aria-checked")).toBe("true");
    expect(activeLabels()).toEqual(["Manual"]);
  });
});

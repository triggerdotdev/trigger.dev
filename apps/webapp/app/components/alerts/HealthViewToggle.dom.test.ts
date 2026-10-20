// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { HealthViewToggle, type HealthView } from "./HealthViewToggle";

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function Harness({ seen }: { seen: HealthView[] }) {
  const [view, setView] = useState<HealthView>("together");
  seen.push(view);
  return createElement(HealthViewToggle, { value: view, onChange: setView });
}

describe("HealthViewToggle", () => {
  it("renders Health and Metrics segments and flips the view", () => {
    const seen: HealthView[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(Harness, { seen })));

    const radios = [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios[0]!.textContent).toBe("Health");
    expect(radios[1]!.textContent).toBe("");
    expect(radios[1]!.getAttribute("aria-label")).toContain("Metrics");
    expect(container.textContent).not.toMatch(/Together|Separate/);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);

    act(() => radios[1]!.click());
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(seen[seen.length - 1]).toBe("separate");
  });
});

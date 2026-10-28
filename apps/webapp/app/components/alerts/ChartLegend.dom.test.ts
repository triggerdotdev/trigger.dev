// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChartLegend, warningLegendItem, type ChartLegendItem } from "./ChartLegend";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const series = (n: number): ChartLegendItem[] =>
  Array.from({ length: n }, (_, i) => ({
    swatch: "line" as const,
    color: `#00000${i}`,
    label: `Series ${i + 1}`,
  }));

const render = (items: ChartLegendItem[]) =>
  act(() => root.render(createElement(ChartLegend, { items })));

describe("ChartLegend", () => {
  it("compacts more than three series into dots and a +N popover listing all of them", () => {
    render([...series(7), warningLegendItem("Above threshold")]);
    const entries = [...container.firstElementChild!.children].map((el) => el.textContent);
    expect(entries.slice(0, 4)).toEqual(["Above threshold", "Series 1", "Series 2", "Series 3"]);
    expect(container.textContent).not.toContain("Series 4");
    expect(container.firstElementChild!.firstElementChild!.textContent).toBe("Above threshold");
    const chip = container.querySelector("button")!;
    expect(chip.textContent).toBe("See all");
    act(() => chip.click());
    const text = document.body.textContent ?? "";
    for (let i = 1; i <= 7; i += 1) expect(text).toContain(`Series ${i}`);
  });

  it("keeps labels inline for three series or fewer", () => {
    render([...series(3), warningLegendItem("Above threshold")]);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Series 3");
    expect(container.textContent).toContain("Above threshold");
  });
});

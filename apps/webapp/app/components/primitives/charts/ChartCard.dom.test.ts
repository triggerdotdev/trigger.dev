// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "../OperatingSystemProvider";
import { ShortcutsProvider } from "../ShortcutsProvider";
import { ChartCard } from "./ChartCard";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderFullscreen(props: Parameters<typeof ChartCard>[0]) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, createElement(ChartCard, props))
      )
    )
  );
  const maximize = document.querySelector<HTMLButtonElement>('[aria-label="Maximize chart"]');
  act(() => maximize!.click());
  return document.querySelector('[role="dialog"]')!;
}

function accessibleName(dialog: Element): string {
  const id = dialog.getAttribute("aria-labelledby");
  return (id ? document.getElementById(id)?.textContent : dialog.getAttribute("aria-label")) ?? "";
}

describe("ChartCard fullscreen", () => {
  it("names the dialog after a text title", () => {
    const dialog = renderFullscreen({ title: "Queued runs", children: "chart" });

    expect(accessibleName(dialog)).toContain("Queued runs");
  });

  it("names a titleless card from ariaLabel", () => {
    const dialog = renderFullscreen({ ariaLabel: "Table", children: "table" });

    expect(accessibleName(dialog)).toBe("Table");
  });
});

// @vitest-environment jsdom
import { getCapability } from "@internal/alert-contracts";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { alertChartInfo } from "./alertSummaries";
import { PreviewChartCard } from "./PreviewChartCard";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("detail chart header tooltip", () => {
  it("shows the registry description, not the title, for queue.oldest_age", () => {
    const capability = getCapability("queue.oldest_age")!;
    const description = capability.description!;
    const info = alertChartInfo({
      capabilityDescription: description,
      conditionSummary: "> 100 over 5m",
    });
    expect(info).toBe(description);
    expect(info).not.toBe(capability.title);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(PreviewChartCard, { title: capability.title, info }, "chart")
          )
        )
      )
    );
    const icon = container.querySelector("svg")!.closest("button")!;
    act(() => {
      icon.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    });
    act(() => vi.advanceTimersByTime(500));
    const content = Array.from(document.querySelectorAll("[data-side]")).find((n) =>
      n.textContent?.includes(description)
    )!;
    expect(content.textContent).toContain(description);
    expect(content.className).toContain("max-w-[300px]");
  });
});

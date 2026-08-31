// @vitest-environment jsdom
import { createElement, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { initialAgentMode, type DashboardAgentMode } from "./panel-layout";

describe("initialAgentMode", () => {
  it("opens in the account preference when one is set", () => {
    expect(initialAgentMode("rightPanel")).toBe("rightPanel");
    expect(initialAgentMode("fullscreen")).toBe("fullscreen");
  });

  it("defaults to floating when there is no preference", () => {
    expect(initialAgentMode(undefined)).toBe("floating");
  });
});

type HarnessHandle = {
  mode: DashboardAgentMode;
  changeMode: (mode: DashboardAgentMode) => void;
  close: () => void;
  reopen: () => void;
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

// Mirrors DashboardAgent.tsx's own state shape: mode starts from the preference, an
// in-chat switch is transient (setMode only), and closing reverts to the preference —
// so the next open starts clean regardless of what the last session left it on.
function renderHarness(preference: DashboardAgentMode | undefined) {
  let latest!: HarnessHandle;
  function Harness() {
    const [mode, setMode] = useState<DashboardAgentMode>(() => initialAgentMode(preference));

    const changeMode = useCallback((next: DashboardAgentMode) => setMode(next), []);
    const close = useCallback(() => setMode(initialAgentMode(preference)), []);
    const reopen = useCallback(() => {}, []);

    // oxlint-disable-next-line react/globals -- test harness capturing the latest state/handlers.
    latest = { mode, changeMode, close, reopen };
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness));
  });
  return {
    get current() {
      return latest;
    },
  };
}

describe("a transient in-chat mode switch reverts on close", () => {
  it("switching mode while open, then closing and reopening, lands back on the preference", () => {
    const harness = renderHarness("rightPanel");

    expect(harness.current.mode).toBe("rightPanel");

    act(() => harness.current.changeMode("fullscreen"));
    expect(harness.current.mode).toBe("fullscreen");

    act(() => harness.current.close());
    act(() => harness.current.reopen());

    expect(harness.current.mode).toBe("rightPanel");
  });
});

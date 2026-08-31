// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { initialAgentMode, useAgentPanelMode, type DashboardAgentMode } from "./panel-layout";

describe("initialAgentMode", () => {
  it("opens in the account preference when one is set", () => {
    expect(initialAgentMode("rightPanel")).toBe("rightPanel");
    expect(initialAgentMode("fullscreen")).toBe("fullscreen");
  });

  it("defaults to floating when there is no preference", () => {
    expect(initialAgentMode(undefined)).toBe("floating");
  });
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

// Renders the real hook DashboardAgent.tsx uses for its mode state — not a re-implementation
// — so a regression in the actual reset wiring fails this test.
function renderAgentPanelMode(preference: DashboardAgentMode | undefined) {
  let latest!: ReturnType<typeof useAgentPanelMode>;
  function Harness() {
    // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
    latest = useAgentPanelMode(preference);
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

describe("useAgentPanelMode", () => {
  it("starts from the account preference", () => {
    const hook = renderAgentPanelMode("rightPanel");
    expect(hook.current.mode).toBe("rightPanel");
  });

  it("defaults to floating when there is no preference", () => {
    const hook = renderAgentPanelMode(undefined);
    expect(hook.current.mode).toBe("floating");
  });

  it("a transient changeMode applies immediately but resetToPreference (the close path) reverts it", () => {
    const hook = renderAgentPanelMode("rightPanel");

    act(() => hook.current.changeMode("fullscreen"));
    expect(hook.current.mode).toBe("fullscreen");

    // This is exactly what DashboardAgent.tsx's setPanelOpen calls on close.
    act(() => hook.current.resetToPreference());
    expect(hook.current.mode).toBe("rightPanel");
  });

  it("revertFullscreen (the pathname-change path) drops fullscreen but leaves other transient modes alone", () => {
    const hook = renderAgentPanelMode("floating");

    act(() => hook.current.changeMode("fullscreen"));
    act(() => hook.current.revertFullscreen());
    expect(hook.current.mode).toBe("floating");

    act(() => hook.current.changeMode("rightPanel"));
    act(() => hook.current.revertFullscreen());
    expect(hook.current.mode).toBe("rightPanel");
  });
});

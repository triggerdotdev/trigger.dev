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
function renderAgentPanelMode(preference: DashboardAgentMode | undefined, open = true) {
  let latest!: ReturnType<typeof useAgentPanelMode>;
  type Props = { modePreference: DashboardAgentMode | undefined; panelOpen: boolean };
  function Harness({ modePreference, panelOpen }: Props) {
    // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
    latest = useAgentPanelMode(modePreference, panelOpen);
    return null;
  }
  let props: Props = { modePreference: preference, panelOpen: open };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(createElement(Harness, props));
  });
  const rerender = (next: Partial<Props>) => {
    props = { ...props, ...next };
    act(() => {
      root!.render(createElement(Harness, props));
    });
  };
  return {
    get current() {
      return latest;
    },
    setOpen(next: boolean) {
      rerender({ panelOpen: next });
    },
    setPreference(next: DashboardAgentMode | undefined) {
      rerender({ modePreference: next });
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

  it("revertFullscreen always collapses to floating while open, even when the preference is fullscreen", () => {
    const hook = renderAgentPanelMode("fullscreen");
    expect(hook.current.mode).toBe("fullscreen");

    act(() => hook.current.revertFullscreen());
    expect(hook.current.mode).toBe("floating");
  });

  it("picks up a preference saved while closed, so the next open uses it", () => {
    const hook = renderAgentPanelMode("floating", false);

    hook.setPreference("rightPanel");
    hook.setOpen(true);

    expect(hook.current.mode).toBe("rightPanel");
  });

  it("leaves an open panel's mode alone when the preference changes, and applies it once closed", () => {
    const hook = renderAgentPanelMode("floating", true);

    hook.setPreference("rightPanel");
    expect(hook.current.mode).toBe("floating");

    hook.setOpen(false);
    expect(hook.current.mode).toBe("rightPanel");
  });

  it("navigating while closed keeps a fullscreen preference, so the next open is fullscreen", () => {
    const hook = renderAgentPanelMode("fullscreen", false);

    act(() => hook.current.revertFullscreen());
    hook.setOpen(true);

    expect(hook.current.mode).toBe("fullscreen");
  });
});

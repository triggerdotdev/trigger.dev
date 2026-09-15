// @vitest-environment jsdom
// Drives the real `PanelGroup`/`Panel` pair with the component's own callbacks, because the
// bug is an ordering one: the panel's constraint effect reports a size before the parent's
// mode effect runs. jsdom has no layout and no ResizeObserver, so those two browser pieces
// are supplied here — everything else is the library and the component's own logic.
import { Panel, PanelGroup, PanelResizer, type PanelHandle } from "@window-splitter/react";
import { createElement, useCallback, useEffect, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockedWidthController, type DockedWidthAction } from "./docked-width";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  AGENT_PANEL_MAX_WIDTH,
  AGENT_PANEL_MIN_WIDTH,
  readAgentPanelWidth,
  writeAgentPanelWidth,
} from "./panel-layout";

const GROUP_WIDTH = 1400;
const GROUP_HEIGHT = 800;

type Observed = { element: Element; callback: ResizeObserverCallback };
let observed: Observed[] = [];
let container: HTMLDivElement | undefined;
let root: Root | undefined;
let originalObserver: typeof ResizeObserver | undefined;
// Held through a callback ref, so nothing ref-shaped is touched while rendering.
let panelHandle: PanelHandle | null = null;

class StubResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(element: Element) {
    observed.push({ element, callback: this.callback });
  }
  unobserve() {}
  disconnect() {
    observed = observed.filter((entry) => entry.callback !== this.callback);
  }
}

/** Report what a browser would have laid out for the current template. */
function reportSizes(sizes: Record<string, number>) {
  act(() => {
    for (const { element, callback } of [...observed]) {
      const id = element.getAttribute("data-splitter-id");
      if (!id) continue;
      const width = sizes[id];
      if (width === undefined) continue;
      callback(
        [
          {
            target: element,
            borderBoxSize: [{ inlineSize: width, blockSize: GROUP_HEIGHT }],
            contentRect: { width, height: GROUP_HEIGHT },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver
      );
    }
  });
}

// Mirrors DashboardAgent's panel wiring, with its real controller and storage helpers.
function AgentSplit({ docked }: { docked: boolean }) {
  // A plain value rather than a ref: the callbacks below are props, and reading a ref from
  // one of those counts as a render-time ref access.
  const controller = useMemo(() => createDockedWidthController(), []);
  const takeHandle = useCallback((handle: PanelHandle | null) => {
    panelHandle = handle;
  }, []);

  const run = useCallback((action: DockedWidthAction) => {
    if (action.type === "apply") panelHandle?.setSize(`${action.width}px`);
    if (action.type === "persist") writeAgentPanelWidth(action.width);
  }, []);

  useEffect(() => {
    run(
      docked
        ? controller.dock(readAgentPanelWidth(), panelHandle?.getPixelSize())
        : controller.undock()
    );
  }, [controller, docked, run]);

  const onResize = useCallback(
    ({ pixel }: { pixel: number }) => {
      run(controller.resize(pixel));
    },
    [controller, run]
  );

  return createElement(
    PanelGroup,
    { orientation: "horizontal", autosaveId: "dashboard-agent-split-v2" },
    createElement(Panel, { id: "dashboard-content", min: "320px", key: "content" }),
    createElement(PanelResizer, {
      id: "dashboard-agent-handle",
      size: docked ? "3px" : "0px",
      key: "handle",
    }),
    createElement(
      Panel,
      {
        id: "dashboard-agent-panel",
        key: "agent",
        handle: takeHandle,
        onResize,
        default: docked ? `${AGENT_PANEL_DEFAULT_WIDTH}px` : "0px",
        min: docked ? `${AGENT_PANEL_MIN_WIDTH}px` : "0px",
        max: docked ? `${AGENT_PANEL_MAX_WIDTH}px` : "0px",
        className: docked ? undefined : "overflow-visible!",
      },
      createElement("div", { "data-testid": "agent-window", key: "window" }, "chat")
    )
  );
}

describe("agent panel docking, rendered", () => {
  beforeEach(() => {
    observed = [];
    originalObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    Element.prototype.getBoundingClientRect = () =>
      ({ width: GROUP_WIDTH, height: GROUP_HEIGHT, x: 0, y: 0, top: 0, left: 0 }) as DOMRect;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    if (originalObserver) globalThis.ResizeObserver = originalObserver;
  });

  function render(docked: boolean) {
    act(() => {
      root!.render(createElement(AgentSplit, { docked }));
    });
  }

  it("keeps the saved width, and does not overwrite it while docking", () => {
    writeAgentPanelWidth(500);

    render(false);
    reportSizes({ "dashboard-content": GROUP_WIDTH, "dashboard-agent-panel": 0 });
    expect(readAgentPanelWidth()).toBe(500);

    render(true);
    // The layout the grid renders first is the panel's default.
    reportSizes({
      "dashboard-content": GROUP_WIDTH - AGENT_PANEL_DEFAULT_WIDTH - 3,
      "dashboard-agent-panel": AGENT_PANEL_DEFAULT_WIDTH,
    });

    expect(readAgentPanelWidth()).toBe(500);
    expect(Math.round(panelHandle?.getPixelSize() ?? 0)).toBe(500);
  });

  // The window renders inside the zero-width column in floating and fullscreen mode, so it
  // has to stay mounted and unclipped there — otherwise the panel is open but invisible,
  // which also hides the launcher, since the launcher hides whenever the panel is open.
  it("keeps the window mounted and unclipped while the column has no width", () => {
    render(false);
    reportSizes({ "dashboard-content": GROUP_WIDTH, "dashboard-agent-panel": 0 });

    const panel = container!.querySelector('[data-splitter-id="dashboard-agent-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("overflow-visible!");
    expect(container!.querySelector('[data-testid="agent-window"]')?.textContent).toBe("chat");
  });

  it("docks at the default when nothing was saved", () => {
    render(false);
    reportSizes({ "dashboard-content": GROUP_WIDTH, "dashboard-agent-panel": 0 });

    render(true);
    reportSizes({
      "dashboard-content": GROUP_WIDTH - AGENT_PANEL_DEFAULT_WIDTH - 3,
      "dashboard-agent-panel": AGENT_PANEL_DEFAULT_WIDTH,
    });

    expect(Math.round(panelHandle?.getPixelSize() ?? 0)).toBe(AGENT_PANEL_DEFAULT_WIDTH);
    expect(readAgentPanelWidth()).toBe(AGENT_PANEL_DEFAULT_WIDTH);
  });
});

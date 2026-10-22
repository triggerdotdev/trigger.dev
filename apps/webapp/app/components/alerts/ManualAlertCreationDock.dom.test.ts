// @vitest-environment jsdom
import type * as WindowSplitter from "@window-splitter/react";
import type { PanelHandle } from "@window-splitter/react";
import { createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_PANEL_DEFAULT_WIDTH,
  readAgentPanelWidth,
  writeAgentPanelWidth,
} from "~/components/dashboard-agent/panel-layout";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { ManualAlertCreationDock } from "./ManualAlertCreation";

const agentPanel = vi.hoisted(() => ({ handle: null as PanelHandle | null }));

vi.mock("@window-splitter/react", async (importOriginal) => {
  const original = await importOriginal<typeof WindowSplitter>();
  return {
    ...original,
    Panel: (props: ComponentProps<typeof original.Panel>) =>
      createElement(original.Panel, {
        ...props,
        handle: (handle: PanelHandle | null) => {
          if (props.id === "dashboard-agent-panel") agentPanel.handle = handle;
          const ref = props.handle;
          if (typeof ref === "function") ref(handle);
          else if (ref) (ref as { current: PanelHandle | null }).current = handle;
        },
      }),
  };
});
vi.mock("@remix-run/react", () => ({
  useFetcher: () => ({ data: undefined, load: () => {} }),
}));
vi.mock("~/hooks/useTypedMatchData", () => ({ useTypedMatchesData: () => undefined }));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "o", id: "org1" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "p", id: "proj1" }) }));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "e", id: "env1", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useFeatures", () => ({ useFeatures: () => ({ queueMetricsEnabled: true }) }));
vi.mock("~/components/dashboard-agent/alert-creation/ManualCreationForm", () => ({
  ManualCreationForm: () => null,
}));

const GROUP_WIDTH = 1400;
const GROUP_HEIGHT = 800;

type Observed = { element: Element; callback: ResizeObserverCallback };
let observed: Observed[] = [];
let container: HTMLDivElement;
let root: Root;
let originalObserver: typeof ResizeObserver | undefined;
let originalRect: typeof Element.prototype.getBoundingClientRect;

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

function mount() {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            ManualAlertCreationDock,
            {
              open: true,
              prefill: {},
              alertDetailPath: (id: string) => `/alerts/${id}`,
              onCreated: () => {},
              onClose: () => {},
            },
            createElement("div", null, "page")
          )
        )
      )
    )
  );
}

const panelColumn = () =>
  container.querySelector<HTMLElement>('[data-splitter-id="dashboard-agent-panel"]')!;
describe("ManualAlertCreationDock, rendered", () => {
  beforeEach(() => {
    observed = [];
    originalObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () =>
      ({ width: GROUP_WIDTH, height: GROUP_HEIGHT, x: 0, y: 0, top: 0, left: 0 }) as DOMRect;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Element.prototype.getBoundingClientRect = originalRect;
    if (originalObserver) globalThis.ResizeObserver = originalObserver;
  });

  it("restores the saved width on the first size report", () => {
    writeAgentPanelWidth(500);
    mount();
    expect(panelColumn()).not.toBeNull();
    expect(Math.round(agentPanel.handle?.getPixelSize() ?? 0)).not.toBe(500);
    reportSizes({
      "dashboard-content": GROUP_WIDTH - AGENT_PANEL_DEFAULT_WIDTH - 3,
      "dashboard-agent-panel": AGENT_PANEL_DEFAULT_WIDTH,
    });
    expect(Math.round(agentPanel.handle?.getPixelSize() ?? 0)).toBe(500);
    expect(readAgentPanelWidth()).toBe(500);
  });

  it("covers the full width below the sm breakpoint", () => {
    mount();
    const surface = container.querySelector("[data-testid=manual-alert-panel]")!;
    expect(surface.className).toContain("max-sm:fixed");
    expect(surface.className).toContain("max-sm:inset-0");
  });
});

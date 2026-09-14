// @vitest-environment jsdom
import {
  buildTemplate,
  getPanelGroupPixelSizes,
  groupMachine,
  initializePanel,
  initializePanelHandleData,
  prepareSnapshot,
  type GroupMachineContextValue,
  type PanelData,
} from "@window-splitter/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The `ResizablePanel` setup the agent panel uses: a collapsible right panel that is
// collapsed in every mode but `rightPanel`, in a group that autosaves to localStorage.
const GROUP_ID = "dashboard-agent-split";
const WIDTH = 1400;
const HEIGHT = 800;

function agentPanel(collapsed: boolean) {
  return initializePanel({
    id: "agent",
    default: "380px",
    min: "320px",
    max: "720px",
    collapsible: true,
    collapsed,
    collapsedSize: "0px",
  } as Parameters<typeof initializePanel>[0]);
}

function mount({
  collapsed,
  snapshot,
}: {
  collapsed?: boolean;
  snapshot?: Record<string, unknown>;
}) {
  const [context, send, state] = groupMachine({
    size: { width: WIDTH, height: HEIGHT },
    orientation: "horizontal",
    groupId: GROUP_ID,
    autosaveStrategy: "localStorage",
    ...(snapshot ? prepareSnapshot(snapshot as never) : undefined),
  } as Parameters<typeof groupMachine>[0]);

  if (!snapshot) {
    send({
      type: "registerPanel",
      data: initializePanel({ id: "content", min: "320px" } as Parameters<
        typeof initializePanel
      >[0]),
    });
    send({
      type: "registerPanelHandle",
      data: initializePanelHandleData({ id: "handle", size: "3px" }),
    });
    send({ type: "registerPanel", data: agentPanel(collapsed ?? false) });
  }
  send({ type: "setSize", size: { width: WIDTH, height: HEIGHT } });
  return { context, send, state };
}

/** Report what the browser would measure, which is what turns the `-1` sentinel into pixels. */
function measure(
  send: ReturnType<typeof mount>["send"],
  sizes: { content: number; agent: number }
) {
  send({
    type: "setActualItemsSize",
    childrenSizes: {
      content: { width: sizes.content, height: HEIGHT },
      agent: { width: sizes.agent, height: HEIGHT },
    },
  });
}

function agentSize(context: GroupMachineContextValue) {
  return getPanelGroupPixelSizes(context)[2];
}

function agentItem(context: GroupMachineContextValue) {
  return context.items[2] as PanelData;
}

const settled = (context: GroupMachineContextValue) =>
  vi.waitFor(() => expect(agentSize(context)).toBeGreaterThan(0));

describe("collapsible panel expand", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("expands to its default when it was collapsed before the first measurement", async () => {
    const { context, send } = mount({ collapsed: false });
    // Fullscreen collapses the panel while its size is still the registration sentinel.
    send({ type: "collapsePanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentItem(context).collapsed).toBe(true));
    measure(send, { content: WIDTH, agent: 0 });

    send({ type: "expandPanel", panelId: "agent", controlled: true });
    await settled(context);
    expect(agentSize(context)).toBe(380);
  });

  it("restores the size the user dragged to", async () => {
    const { context, send } = mount({ collapsed: false });
    measure(send, { content: WIDTH - 383, agent: 380 });
    send({ type: "setPanelPixelSize", panelId: "agent", size: "500px" });
    expect(agentSize(context)).toBe(500);

    send({ type: "collapsePanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentSize(context)).toBe(0));
    send({ type: "expandPanel", panelId: "agent", controlled: true });
    await settled(context);
    expect(agentSize(context)).toBe(500);
  });

  it("recovers from an autosaved snapshot that remembers a collapsed size", async () => {
    const { context, send } = mount({ collapsed: false });
    send({ type: "collapsePanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentItem(context).collapsed).toBe(true));

    const snapshot = JSON.parse(localStorage.getItem(GROUP_ID) as string);
    expect(agentItem(snapshot).currentValue.value).toBe("0");
    // What a browser that hit the bug has stored: collapsed at 0px, remembering -1.
    snapshot.items[2].sizeBeforeCollapse = -1;

    const reloaded = mount({ snapshot });
    measure(reloaded.send, { content: WIDTH, agent: 0 });
    reloaded.send({ type: "expandPanel", panelId: "agent", controlled: true });
    await settled(reloaded.context);
    expect(agentSize(reloaded.context)).toBe(380);
    // Collapsing a panel that is already at 0px must not record that as its size,
    // or the next expand has nothing to restore.
    const drifted = JSON.parse(localStorage.getItem(GROUP_ID) as string);
    drifted.items[2].collapsed = false;
    drifted.items[2].currentValue = { type: "pixel", value: "0" };
    drifted.items[2].sizeBeforeCollapse = undefined;
    const second = mount({ snapshot: drifted });
    second.send({ type: "collapsePanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentItem(second.context).collapsed).toBe(true));
    expect(agentItem(second.context).sizeBeforeCollapse).toBeUndefined();
    second.send({ type: "expandPanel", panelId: "agent", controlled: true });
    await settled(second.context);
    expect(agentSize(second.context)).toBe(380);
  });
});

describe("collapsible panel stays open", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("survives a later measurement that overflows the group", async () => {
    const { context, send } = mount({ collapsed: false });
    measure(send, { content: WIDTH - 383, agent: 380 });
    expect(agentSize(context)).toBe(380);

    // A page whose content settles later reports children wider than the group.
    measure(send, { content: 1200, agent: 380 });
    expect(agentItem(context).collapsed).toBe(false);
    expect(agentSize(context)).toBeGreaterThanOrEqual(320);
  });

  it("expands on the first switch from a snapshot saved at another width", async () => {
    const { context, send } = mount({ collapsed: false });
    measure(send, { content: WIDTH - 383, agent: 380 });
    send({ type: "collapsePanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentItem(context).collapsed).toBe(true));

    const snapshot = JSON.parse(localStorage.getItem(GROUP_ID) as string);
    snapshot.size = { width: 1800, height: HEIGHT };

    const reloaded = mount({ snapshot });
    reloaded.send({ type: "expandPanel", panelId: "agent", controlled: true });
    await settled(reloaded.context);
    expect(agentSize(reloaded.context)).toBe(380);
  });
});

describe("collapsible panel drift from the controlled prop", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("ignores a 0 measurement that arrives after the panel reopened", async () => {
    const { context, send } = mount({ collapsed: false });
    measure(send, { content: WIDTH - 383, agent: 380 });
    send({ type: "collapsePanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentItem(context).collapsed).toBe(true));
    send({ type: "expandPanel", panelId: "agent", controlled: true });
    await settled(context);
    expect(agentSize(context)).toBe(380);

    // The collapsed frame's ResizeObserver entry lands late...
    send({ type: "setActualItemsSize", childrenSizes: { agent: { width: 0, height: HEIGHT } } });
    // ...and any later commit would otherwise bake it into the layout.
    send({
      type: "updateConstraints",
      data: initializePanelHandleData({ id: "handle", size: "3px" }),
    });
    expect(agentItem(context).collapsed).toBe(false);
    expect(agentSize(context)).toBe(380);
  });

  it("opens on a controlled expand sent before the group is measured", async () => {
    const [context, send] = groupMachine({
      size: { width: 0, height: 0 },
      orientation: "horizontal",
      groupId: GROUP_ID,
    } as Parameters<typeof groupMachine>[0]);
    send({
      type: "registerPanel",
      data: initializePanel({ id: "content", min: "320px" } as Parameters<
        typeof initializePanel
      >[0]),
    });
    send({
      type: "registerPanelHandle",
      data: initializePanelHandleData({ id: "handle", size: "3px" }),
    });
    send({ type: "registerPanel", data: agentPanel(true) });

    send({ type: "expandPanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentItem(context).collapsed).toBe(false));
    // Unmeasured but open: the template falls back to the panel's default.
    expect(buildTemplate(context)).toContain("380px");
  });
});

// The agent panel's own shape after the change of approach: no collapse state at all, just
// constraints that go to 0/0 outside the docked mode, with the width applied by `setSize`.
describe("panel sized by constraints instead of collapse state", () => {
  // Mirrors the component: a constant default (never the persisted width, which the server
  // cannot know) and the real width applied imperatively.
  const constrained = (docked: boolean) =>
    initializePanel({
      id: "agent",
      default: docked ? "380px" : "0px",
      min: docked ? "320px" : "0px",
      max: docked ? "720px" : "0px",
    } as Parameters<typeof initializePanel>[0]);

  function dockedGroup() {
    const [context, send] = groupMachine({
      size: { width: WIDTH, height: HEIGHT },
      orientation: "horizontal",
      groupId: "dashboard-agent-split-v2",
      autosaveStrategy: "localStorage",
    } as Parameters<typeof groupMachine>[0]);
    send({
      type: "registerPanel",
      data: initializePanel({ id: "content", min: "320px" } as Parameters<
        typeof initializePanel
      >[0]),
    });
    send({
      type: "registerPanelHandle",
      data: initializePanelHandleData({ id: "handle", size: "0px" }),
    });
    send({ type: "registerPanel", data: constrained(false) });
    send({ type: "setSize", size: { width: WIDTH, height: HEIGHT } });

    // Mirrors the component's order: switch the constraints, let the browser report the
    // default layout, and only then apply the saved width — sizing a panel that was never
    // measured yields a negative fraction the grid clamps to `min`.
    const dock = (docked: boolean, width?: number) => {
      send({
        type: "updateConstraints",
        data: initializePanelHandleData({ id: "handle", size: docked ? "3px" : "0px" }),
      });
      send({ type: "updateConstraints", data: constrained(docked) });
      if (!docked) {
        measure(send, { content: WIDTH, agent: 0 });
        return;
      }
      measure(send, { content: WIDTH - 383, agent: 380 });
      if (width) send({ type: "setPanelPixelSize", panelId: "agent", size: `${width}px` });
      measure(send, { content: WIDTH - (width ?? 380) - 3, agent: width ?? 380 });
    };
    return { context, send, dock };
  }

  // The machine's own committed width, not `getPanelGroupPixelSizes`: that one prefers the
  // measurement fed back in, so it would report the right width even with no `setSize`.
  const machineWidth = (context: GroupMachineContextValue, staticWidth: number) => {
    const value = agentItem(context).currentValue;
    return value.type === "pixel"
      ? Math.round(Number(value.value))
      : Math.round(Number(value.value) * (WIDTH - staticWidth));
  };

  // Outside the docked mode the track's max is 0, so the browser gives it no width; the
  // machine's own value is irrelevant then, which is the point of dropping collapse state.
  const agentTrackIsZero = (context: GroupMachineContextValue) => {
    const template = buildTemplate(context);
    return template.endsWith(" 0px") || template.endsWith(", 0px))");
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it("gives the column no width outside the docked mode and the saved width back", () => {
    const { context, dock } = dockedGroup();
    expect(buildTemplate(context)).toContain("minmax(320px, 1fr)");
    expect(agentTrackIsZero(context)).toBe(true);

    dock(true, 500);
    expect(machineWidth(context, 3)).toBe(500);
    expect(buildTemplate(context)).toContain("720px");
    dock(false);
    expect(agentTrackIsZero(context)).toBe(true);
    dock(true, 500);
    expect(machineWidth(context, 3)).toBe(500);
  });

  it("docks at the default width when nothing was ever saved", () => {
    const { context, dock } = dockedGroup();
    // What the app passes on a first-ever dock: its default, never the min.
    dock(true, 380);
    expect(machineWidth(context, 3)).toBe(380);
  });

  // Why the component waits for a measurement before applying the saved width: this is the
  // path that used to land a first-ever dock on 320px (the min) instead of the saved width.
  it("cannot size a panel the layout has never measured", () => {
    const { context, send } = dockedGroup();
    send({
      type: "updateConstraints",
      data: initializePanelHandleData({ id: "handle", size: "3px" }),
    });
    send({ type: "updateConstraints", data: constrained(true) });
    send({ type: "setPanelPixelSize", panelId: "agent", size: "500px" });
    expect(machineWidth(context, 3)).not.toBe(500);
    // ...and once it has a width, the same call lands exactly.
    measure(send, { content: WIDTH - 383, agent: 380 });
    send({ type: "setPanelPixelSize", panelId: "agent", size: "500px" });
    expect(machineWidth(context, 3)).toBe(500);
  });

  it("keeps the width across repeated toggles and a stale 0 measurement", () => {
    const { context, send, dock } = dockedGroup();
    dock(true, 420);
    for (let i = 0; i < 3; i++) {
      dock(false);
      send({ type: "setActualItemsSize", childrenSizes: { agent: { width: 0, height: HEIGHT } } });
      dock(true, 420);
    }
    expect(machineWidth(context, 3)).toBe(420);
    expect(agentItem(context).collapsed).toBeUndefined();
  });
});

describe("controlled expand guards", () => {
  it("expands a controlled panel even where no width satisfies every min", async () => {
    const narrow = 600;
    const [context, send] = groupMachine({
      size: { width: narrow, height: HEIGHT },
      orientation: "horizontal",
      groupId: "narrow",
    } as Parameters<typeof groupMachine>[0]);
    send({
      type: "registerPanel",
      data: initializePanel({ id: "content", min: "400px" } as Parameters<
        typeof initializePanel
      >[0]),
    });
    send({
      type: "registerPanelHandle",
      data: initializePanelHandleData({ id: "handle", size: "3px" }),
    });
    send({ type: "registerPanel", data: agentPanel(true) });
    measure(send, { content: narrow, agent: 0 });

    send({ type: "expandPanel", panelId: "agent", controlled: true });
    await vi.waitFor(() => expect(agentItem(context).collapsed).toBe(false));
    // Both mins cannot fit: the sibling holds its min and the group overflows rather than
    // leaving the panel shut behind its prop.
    const [content, handle, agent] = getPanelGroupPixelSizes(context);
    expect(agent).toBe(380);
    expect(content).toBe(400);
    expect(content + handle + agent).toBeGreaterThan(narrow);
  });

  it("still vetoes an uncontrolled expand before the group is measured", async () => {
    const [context, send] = groupMachine({
      size: { width: 0, height: 0 },
      orientation: "horizontal",
      groupId: "unmeasured",
    } as Parameters<typeof groupMachine>[0]);
    send({
      type: "registerPanel",
      data: initializePanel({ id: "content", min: "320px" } as Parameters<
        typeof initializePanel
      >[0]),
    });
    send({
      type: "registerPanelHandle",
      data: initializePanelHandleData({ id: "handle", size: "3px" }),
    });
    send({ type: "registerPanel", data: agentPanel(true) });

    send({ type: "expandPanel", panelId: "agent" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agentItem(context).collapsed).toBe(true);
  });
});

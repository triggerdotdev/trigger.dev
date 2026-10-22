// @vitest-environment jsdom
import { createElement, useState, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  useCreationFlowState,
  type CreationFlowState,
} from "~/components/dashboard-agent/alert-creation/CreationFlow";
import { CreationTranscript, type AddChannelAccess } from "./CreationTranscript";

vi.mock("~/components/primitives/Dialog", () => ({
  Dialog: ({ children, onOpenChange }: any) =>
    createElement(
      "div",
      { "data-testid": "dialog" },
      createElement("button", { onClick: () => onOpenChange(false) }, "Close dialog"),
      children
    ),
  DialogContent: ({ children }: any) => createElement("div", null, children),
  DialogHeader: ({ children }: any) => createElement("h2", null, children),
}));
vi.mock("~/hooks/useOrganizations", () => ({ useOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useProject: () => ({ slug: "proj", id: "p1" }) }));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "prod", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useShowSelfServe", () => ({ useShowSelfServe: () => true }));
vi.mock("~/components/Feedback", () => ({ Feedback: () => null }));

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const NEW_CHANNEL = { id: "ch_new", name: "Email to ops@example.com", type: "EMAIL" };
const posted: FormData[] = [];
const channelsLoader = vi.fn(async () => ({
  alertChannels: [],
  limits: { used: 0, limit: 10 },
  canWrite: true,
  form: { slack: { status: "NOT_CONFIGURED" }, emailAlertsEnabled: true },
}));
const onCreated = vi.fn();

let container: HTMLElement;
let root: Root;
let latest: CreationFlowState | undefined;

function Harness({ access }: { access: AddChannelAccess }) {
  const flow = useCreationFlowState(undefined, {
    area: "queues",
    what: "queue.depth",
    scope: "all",
    condition: "100",
  });
  // eslint-disable-next-line -- test harness captures the hook return
  latest = flow;
  const [channels] = useState([{ id: "ch_1", name: "Ops webhook", type: "WEBHOOK" }]);
  return createElement(CreationTranscript, { flow, channels, addChannel: access });
}

function mount(access: Partial<AddChannelAccess> = {}) {
  const full: AddChannelAccess = {
    projectId: "p1",
    canWrite: true,
    atLimit: false,
    onCreated,
    ...access,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(ShortcutsProvider, null, createElement(Harness, { access: full }))
      ),
    },
    {
      path: "/orgs/org/projects/proj/env/prod/alerts/channels",
      loader: () => channelsLoader(),
    },
    {
      path: "/resources/alerts/channels",
      action: async ({ request }) => {
        posted.push(await request.formData());
        return { channel: NEW_CHANNEL };
      },
    },
  ]);
  act(() => root.render(createElement(RouterProvider, { router })));
  pickCard("No expiry");
}

function pickCard(label: string) {
  const btn = Array.from(card()!.querySelectorAll("button")).find((b) => b.textContent === label)!;
  act(() => btn.click());
}

const card = () => document.querySelector<HTMLElement>("[role=dialog]");
const addRow = () =>
  Array.from(card()!.querySelectorAll<HTMLButtonElement>("li button")).find(
    (b) => b.textContent === "Add channel…"
  );

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("add a channel from the notifiers step", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    posted.length = 0;
    channelsLoader.mockClear();
    onCreated.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows Add channel enabled with write access", () => {
    mount();
    expect(latest!.currentStep).toBe("notifiers");
    expect(addRow()?.disabled).toBe(false);
    expect(addRow()?.querySelectorAll("svg")).toHaveLength(0);
  });

  it("disables Add channel without write access or at the channel limit", () => {
    mount({ canWrite: false });
    expect(addRow()?.disabled).toBe(true);
    act(() => root.unmount());
    root = createRoot(container);
    mount({ atLimit: true });
    expect(addRow()?.disabled).toBe(true);
  });

  it("opens the channels modal with an inline add-channel form", async () => {
    mount();
    act(() => addRow()!.click());
    await flush();
    const dialog = document.querySelector('[data-testid="dialog"]')!;
    expect(dialog.textContent).toContain("Channels");
    expect(dialog.textContent).not.toContain("Add channel");
    expect(dialog.querySelector("#create-alert")).not.toBeNull();
    expect(channelsLoader).toHaveBeenCalledTimes(1);
    expect(document.querySelector('input[type="email"]')).not.toBeNull();
  });

  it("creates a channel, refetches the modal list and refetches notifiers on close", async () => {
    mount();
    act(() => addRow()!.click());
    await flush();

    const email = document.querySelector<HTMLInputElement>('input[type="email"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(email, "ops@example.com");
      email.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Save"
    )!;
    act(() => save.click());
    await flush();
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.get("channelValue")).toBe("ops@example.com");
    expect(channelsLoader.mock.calls.length).toBeGreaterThan(1);
    expect(document.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(onCreated).not.toHaveBeenCalled();

    const close = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Close dialog"
    )!;
    act(() => close.click());
    expect(document.querySelector('[data-testid="dialog"]')).toBeNull();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(latest!.answers.notifiers).toContain("ch_new");
    expect(latest!.currentStep).toBe("notifiers");
  });
});

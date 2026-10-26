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
vi.mock("~/hooks/useOrganizations", () => ({
  useOrganization: () => ({ slug: "org" }),
  useOptionalOrganization: () => ({ slug: "org" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useProject: () => ({ slug: "proj", id: "p1" }),
  useOptionalProject: () => ({ slug: "proj", id: "p1" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ slug: "prod", type: "PRODUCTION" }),
  useOptionalEnvironment: () => ({ slug: "prod", type: "PRODUCTION" }),
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
let slack: Record<string, unknown> = { status: "NOT_CONFIGURED" };
let existing: unknown[] = [];
const EXISTING_CHANNEL = {
  id: "ch_1",
  name: "Ops webhook",
  type: "WEBHOOK",
  enabled: true,
  alertTypes: ["TASK_RUN"],
  environmentTypes: ["PRODUCTION"],
  properties: { type: "WEBHOOK", url: "https://example.com/hook" },
};
let hold: Promise<void> | undefined;
let startManual = false;
const channelsLoader = vi.fn(async () => {
  await hold;
  return {
    alertChannels: existing,
    limits: { used: existing.length, limit: 10 },
    canWrite: true,
    form: { slack, emailAlertsEnabled: true },
  };
});
const onCreated = vi.fn();

let container: HTMLElement;
let root: Root;
let latest: CreationFlowState | undefined;
let router: ReturnType<typeof createMemoryRouter>;

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
  const [resumed, setResumed] = useState(access.resumed ?? false);
  const [manual, setManual] = useState(startManual);
  return createElement(CreationTranscript, {
    flow,
    channels,
    manual,
    onManualChange: setManual,
    onFreeText: () => {},
    addChannel: { ...access, resumed, onResumeConsumed: () => setResumed(false) },
  });
}

function mount(access: Partial<AddChannelAccess> = {}, entry = "/") {
  const full: AddChannelAccess = {
    projectId: "p1",
    environmentId: "e1",
    canWrite: true,
    atLimit: false,
    onCreated,
    ...access,
  };
  router = createMemoryRouter(
    [
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
      { path: "/orgs/org/projects/proj/env/prod/alerts/new/connect-to-slack", element: null },
    ],
    { initialEntries: [entry] }
  );
  act(() => root.render(createElement(RouterProvider, { router })));
  if (!access.resumed) pickCard("No expiry");
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
    sessionStorage.clear();
    slack = { status: "NOT_CONFIGURED" };
    hold = undefined;
    startManual = false;
    existing = [];
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

  it("saves the answers and returns to the creation card when connecting Slack", async () => {
    const returnTo = "/orgs/org/projects/proj/env/prod/alerts?create=1&add=slack";
    mount({ connectReturnTo: returnTo });
    act(() => latest!.toggleNotifier("ch_1"));
    act(() => addRow()!.click());
    await flush();
    const slackTab = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]')).find(
      (b) => b.textContent === "Slack"
    )!;
    act(() => slackTab.click());

    const connect = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Connect to Slack")
    )!;
    expect(new URL(connect.href).searchParams.get("returnTo")).toBe(returnTo);
    act(() => connect.click());
    expect(JSON.parse(sessionStorage.getItem("alerts.slackConnectResume.p1.e1")!)).toMatchObject({
      what: "queue.depth",
      condition: "100",
      expiry: "none",
      notifiers: ["ch_1"],
    });
  });

  it("reopens the channels modal on Slack and selects the created channel", async () => {
    slack = {
      status: "READY",
      integrationId: "int_1",
      channels: [{ id: "C123", name: "alerts", is_private: false }],
    };
    existing = [EXISTING_CHANNEL];
    mount({ resumed: true }, "/?add=slack");
    await flush();
    expect(latest!.currentStep).toBe("notifiers");
    expect(document.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(document.querySelector('input[name="integrationId"]')).not.toBeNull();

    const form = document.querySelector<HTMLFormElement>("#create-alert")!;
    const value = document.createElement("input");
    value.type = "hidden";
    value.name = "channelValue";
    value.value = "C123/alerts";
    form.appendChild(value);
    act(() => form.requestSubmit());
    await flush();
    await flush();

    expect(posted[0]!.get("type")).toBe("SLACK");
    const close = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Close dialog"
    )!;
    act(() => close.click());
    expect(latest!.answers.notifiers).toContain("ch_new");
  });

  it("reopens on the Slack form even when the URL marker is cleared before channels load", async () => {
    slack = {
      status: "READY",
      integrationId: "int_1",
      channels: [{ id: "C123", name: "alerts", is_private: false }],
    };
    existing = [EXISTING_CHANNEL];
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    mount({ resumed: true }, "/?add=slack");
    await act(async () => router.navigate("/", { replace: true }));
    await act(async () => release());
    await flush();
    await flush();

    expect(document.querySelector("#create-alert")).not.toBeNull();
    expect(document.querySelector('input[name="integrationId"]')).not.toBeNull();
  });

  it("opens a later Add channel on the list, not the Slack form", async () => {
    slack = {
      status: "READY",
      integrationId: "int_1",
      channels: [{ id: "C123", name: "alerts", is_private: false }],
    };
    existing = [EXISTING_CHANNEL];
    mount({ resumed: true }, "/?add=slack");
    await flush();
    expect(document.querySelector('input[name="integrationId"]')).not.toBeNull();

    const close = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Close dialog"
    )!;
    act(() => close.click());
    pickCard("No expiry");
    act(() => addRow()!.click());
    await flush();

    expect(document.querySelector('[data-testid="dialog"]')).not.toBeNull();
    expect(document.querySelector("#create-alert")).toBeNull();
  });

  describe.each([
    ["Manual", true],
    ["Agent", false],
  ])("resumed in %s", (_label, manualFirst) => {
    it("does not reopen the Slack dialog in the other mode after it is closed", async () => {
      slack = {
        status: "READY",
        integrationId: "int_1",
        channels: [{ id: "C123", name: "alerts", is_private: false }],
      };
      existing = [EXISTING_CHANNEL];
      startManual = manualFirst;
      mount({ resumed: true }, "/?add=slack");
      await flush();
      expect(document.querySelector('input[name="integrationId"]')).not.toBeNull();

      const close = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Close dialog"
      )!;
      act(() => close.click());
      const other = document.querySelector<HTMLElement>('[role="radio"][aria-checked="false"]')!;
      act(() => other.click());
      await flush();

      expect(document.querySelector('[data-testid="dialog"]')).toBeNull();
      expect(document.querySelector("#create-alert")).toBeNull();
    });
  });
});

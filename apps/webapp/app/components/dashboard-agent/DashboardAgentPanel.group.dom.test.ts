// @vitest-environment jsdom
import { createElement, useEffect, useState, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentPanel } from "./DashboardAgentPanel";

vi.mock("~/hooks/useOrganizations", () => ({
  useOrganization: () => ({ id: "org_1", slug: "org", title: "Org" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useProject: () => ({ id: "proj_1", slug: "proj", name: "Proj", externalRef: "proj_ref" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useEnvironment: () => ({ id: "env_1", slug: "prod", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useUser", () => ({ useUser: () => ({ id: "user_1", name: "U" }) }));
vi.mock("~/hooks/useDashboardAgentBaseUrl", () => ({
  useDashboardAgentBaseUrl: () => "http://localhost",
}));
vi.mock("~/hooks/useAgentPageContext", () => ({
  useAgentPageContext: () => ({ page: { kind: "other", path: "/" }, signals: [] }),
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
(HTMLElement.prototype as any).scrollIntoView ??= () => {};

const MEMBERS = [
  { id: "alert_a", name: "Depth" },
  { id: "alert_b", name: "Failures" },
];

let container: HTMLElement;
let root: Root;
const bodies: Record<string, unknown>[] = [];
let noData = false;
let sessions = 0;
let noSession = false;
let hold: Promise<void> | undefined;
let intents: unknown[] = [];
let router: ReturnType<typeof createMemoryRouter>;
const GROUP_MESSAGE = {
  id: "alert_created:alert_new",
  role: "assistant",
  parts: [
    { type: "text", text: "done" },
    {
      type: "data-view",
      data: {
        blocks: [
          {
            type: "alert_created",
            id: "alert:alert_new",
            revision: 0,
            version: 1,
            alertId: "alert_new",
            name: "Prod",
            rows: [{ label: "Watching", value: "Raises when: all of 2 alerts (Depth, Failures)." }],
          },
        ],
      },
    },
  ],
};

const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === label
  );
const newChatButton = () => document.querySelector<HTMLElement>('[aria-label="New chat"]')!;
const option = (label: string) =>
  Array.from(document.querySelectorAll<HTMLElement>("li button, li [role=option]")).find((r) =>
    r.textContent?.includes(label)
  );
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const groupSeq = { set: (_seq: number) => {} };

function Harness() {
  const [seq, setSeq] = useState(1);
  useEffect(() => {
    groupSeq.set = setSeq;
  }, []);
  return createElement(DashboardAgentPanel, {
    onClose: () => {},
    groupAlertsRequest: { members: MEMBERS, seq },
  });
}

describe("DashboardAgentPanel group mode", () => {
  beforeEach(async () => {
    bodies.length = 0;
    noData = false;
    sessions = 0;
    noSession = false;
    hold = undefined;
    intents = [];
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string | FormData }) => {
        if (url !== "/resources/alerts/group") {
          const intent = init?.body instanceof FormData ? init.body.get("intent") : undefined;
          if (intent) intents.push(intent);
          if (intent === "create-session") sessions++;
          return new Response(
            JSON.stringify(
              intent === "create-session" && !noSession
                ? { chatId: "chat_1" }
                : { chats: [], channels: [] }
            )
          );
        }
        bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        await hold;
        return noData
          ? new Response("", { status: 500 })
          : new Response(
              JSON.stringify({ ok: true, path: "/alerts/alert_new", message: GROUP_MESSAGE })
            );
      })
    );
    router = createMemoryRouter([
      {
        path: "/",
        element: createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(ShortcutsProvider, null, createElement(Harness))
        ),
        children: [{ path: "alerts/alert_new", element: null }],
      },
      {
        path: "/resources/alerts/channels",
        loader: () => ({
          channels: [{ id: "ch1", name: "Ops webhook", type: "WEBHOOK" }],
          canWrite: true,
        }),
      },
    ]);
    await act(async () => root.render(createElement(RouterProvider, { router })));
    await settle();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const BODY = expect.objectContaining({
    memberAlertIds: ["alert_a", "alert_b"],
    compositeMode: "all",
    name: "Prod",
    notifierChannelIds: ["ch1"],
    expiresAt: expect.any(String),
  });

  async function walkWizard() {
    await act(async () => option("Raise when all")!.click());
    await act(async () => option("Ops webhook")!.click());
    await act(async () => button("Done")!.click());
    await act(async () => option("For 24 hours")!.click());
    type(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, "Prod");
    await act(async () => button("Create group")!.click());
    await settle();
  }

  it("walks the wizard card in the chat and posts the group", async () => {
    const card = () => document.querySelector<HTMLElement>("[role=dialog][aria-label]")!;
    expect(card().textContent).toContain("1 of 4");
    expect(card().textContent).toContain("Groups Depth, Failures.");
    await walkWizard();
    expect(bodies).toEqual([BODY]);
    expect(bodies[0]).toMatchObject({ transcriptChatId: "chat_1" });
    expect(document.querySelector('[data-testid="group-flow"]')).toBeNull();
    expect(button("Create group")).toBeUndefined();
    expect(document.querySelector('[data-testid="alert-created"]')?.textContent).toContain(
      "Prod is active."
    );
    expect(router.state.location.pathname).toBe("/");
    expect(intents).not.toContain("delete");
  });

  it("keeps the card and shows an error when the request fails", async () => {
    noData = true;
    await walkWizard();
    expect(document.querySelector("[role=dialog][aria-label]")).not.toBeNull();
    expect(document.body.textContent).toContain("Could not create the group");
  });

  // Catches: a retried group submit opening a second session.
  it("reuses one session across a failed and a retried submit", async () => {
    noData = true;
    await walkWizard();
    noData = false;
    await act(async () => button("Create group")!.click());
    await settle();
    expect(bodies.map((b) => b.transcriptChatId)).toEqual(["chat_1", "chat_1"]);
    expect(sessions).toBe(1);
  });

  it("navigates to the group when no chat could be resolved", async () => {
    noSession = true;
    await walkWizard();
    expect(bodies[0]).not.toHaveProperty("transcriptChatId");
    expect(router.state.location.pathname).toBe("/alerts/alert_new");
  });

  it("does not dismiss a newer wizard when an older submit resolves late", async () => {
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    await walkWizard();
    act(() => groupSeq.set(2));
    await settle();
    hold = undefined;
    await act(async () => release());
    await settle();
    expect(document.querySelector('[data-testid="group-flow"]')).not.toBeNull();
  });

  it("keeps the confirmation chat when New chat lands during the submit", async () => {
    // Catches: the chat is only kept after the POST, so New chat deletes it mid-request.
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    await walkWizard();
    await act(async () => newChatButton().click());
    hold = undefined;
    await act(async () => release());
    await settle();
    expect(intents).not.toContain("delete");
  });

  it("keeps a newer wizard dismissed when an older submit resolves late", async () => {
    // Catches: a late completion rewrites the dismissed seq and resurrects the wizard.
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    await walkWizard();
    act(() => groupSeq.set(2));
    await settle();
    await act(async () => newChatButton().click());
    hold = undefined;
    await act(async () => release());
    await settle();
    expect(document.querySelector('[data-testid="group-flow"]')).toBeNull();
  });

  it("posts the same body from the manual form", async () => {
    await act(async () =>
      document
        .querySelector<HTMLElement>('[data-testid="manual-mode-toggle"] [aria-label^="Manual"]')!
        .click()
    );
    expect(document.querySelector('[data-testid="group-manual-form"]')).not.toBeNull();
    await act(async () =>
      document.querySelector<HTMLElement>('[role=radio][aria-label="Raise when all"]')!.click()
    );
    type(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, "Prod");
    const notifier = Array.from(
      document.querySelectorAll<HTMLLabelElement>('fieldset[data-step="notifiers"] label')
    ).find((l) => l.textContent === "Ops webhook")!;
    await act(async () => notifier.querySelector("input")!.click());
    const trigger = document.querySelector<HTMLButtonElement>(
      'fieldset[data-step="expiry"] button[role=combobox]'
    )!;
    act(() => trigger.focus());
    act(() => trigger.click());
    const item = Array.from(
      document
        .getElementById(trigger.getAttribute("aria-controls") ?? "")!
        .querySelectorAll<HTMLElement>("[role=option]")
    ).find((o) => o.textContent === "For 24 hours")!;
    await act(async () => item.click());
    await act(async () => button("Create group")!.click());
    await settle();
    expect(bodies).toEqual([BODY]);
  });
});

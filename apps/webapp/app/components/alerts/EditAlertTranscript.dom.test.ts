// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { EditAlertTranscript, type EditAlertPrefill } from "./EditAlertTranscript";

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const PREFILL: EditAlertPrefill = {
  alertId: "a_1",
  name: "Queue depth above 100",
  conditionSummary: "Queue depth > 100",
  scopeSummary: "Queues · All queues",
  notifiers: [
    { key: "channel:ch_1", label: "Ops webhook" },
    { key: "chat:chat_9:user_2", label: "This chat" },
  ],
  expiresAt: null,
};

const posted: FormData[] = [];
let container: HTMLElement;
let root: Root;

function mount(
  prefill: EditAlertPrefill = PREFILL,
  addChannel?: ComponentProps<typeof EditAlertTranscript>["addChannel"]
) {
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(EditAlertTranscript, {
            prefill,
            channels: [
              { id: "ch_1", name: "Ops webhook", type: "WEBHOOK" },
              { id: "ch_2", name: "Email to ops", type: "EMAIL" },
            ],
            alertPath: "/alerts/a_1",
            userId: "user_1",
            addChannel,
          })
        )
      ),
    },
    {
      path: "/alerts/a_1",
      action: async ({ request }) => {
        posted.push(await request.formData());
        return { ok: true };
      },
    },
  ]);
  act(() => root.render(createElement(RouterProvider, { router })));
}

const card = () => document.querySelector<HTMLElement>("[role=dialog]");
const row = (label: string) =>
  Array.from(card()!.querySelectorAll<HTMLButtonElement>("li button")).find(
    (b) => b.textContent === label
  )!;

const next = () =>
  act(() =>
    card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.click()
  );

const done = () =>
  Array.from(card()!.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === "Done"
  )!;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("edit an alert in the chat", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    posted.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens on the expiry step with the current value, then the notifiers step", () => {
    mount();
    expect(document.body.textContent).toContain(`Edit ${PREFILL.name}`);
    expect(card()?.textContent).toContain("1 of 2");
    expect(card()?.textContent).toContain("How long should it stay active?");
    expect(
      Array.from(card()!.querySelectorAll("button")).some((b) => b.textContent === "Skip")
    ).toBe(false);
    expect(row("No expiry").querySelector("[aria-label=Selected]")).not.toBeNull();
    next();
    expect(card()?.textContent).toContain("2 of 2");
    expect(card()?.textContent).not.toContain("What would you like me to watch?");
    expect(card()?.textContent).not.toContain("Recurring");
    expect(row("Ops webhook").getAttribute("aria-pressed")).toBe("true");
    expect(row("Email to ops").getAttribute("aria-pressed")).toBe("false");
    const teammate = row("Another member's chat");
    expect(teammate.disabled).toBe(true);
    expect(teammate.getAttribute("aria-pressed")).toBe("true");
  });

  it("Done posts notifiers to the edit action and shows Updated", async () => {
    mount();
    next();
    act(() => row("Email to ops").click());
    const done = Array.from(card()!.querySelectorAll("button")).find(
      (b) => b.textContent === "Done"
    )!;
    act(() => done.click());
    await flush();
    await flush();
    expect(posted).toHaveLength(1);
    expect(Object.fromEntries(posted[0]!)).toEqual({
      intent: "edit",
      notifierIds: "chat:chat_9:user_2,channel:ch_1,channel:ch_2",
      respond: "json",
      expiresAt: "none",
    });
    expect(card()).toBeNull();
    const transcript = document.querySelector('[data-testid="edit-flow"]')!;
    expect(transcript.textContent).toContain("Updated.");
    const updated = document.querySelector('[data-testid="alert-updated"]')!;
    expect(updated.textContent).toContain("Watch");
    expect(updated.textContent).toContain("View alert");
    expect(updated.textContent).toContain(
      "Notifying: Another member's chat, Ops webhook, Email to ops."
    );
  });

  it("unchanged notifiers send no notifier list", async () => {
    mount();
    next();
    act(() => done().click());
    await flush();
    await flush();
    expect(Object.fromEntries(posted[0]!)).toEqual({
      intent: "edit",
      respond: "json",
      expiresAt: "none",
    });
  });

  it("changing the expiry posts the new expiresAt with the edit intent", async () => {
    mount({ ...PREFILL, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    act(() => row("For 24 hours").click());
    act(() => done().click());
    await flush();
    await flush();
    const fields = Object.fromEntries(posted[0]!);
    expect(fields.intent).toBe("edit");
    expect(fields.notifierIds).toBeUndefined();
    const delta = new Date(fields.expiresAt as string).getTime() - Date.now();
    expect(Math.abs(delta - 24 * 3_600_000)).toBeLessThan(60_000);
  });

  it("an active alert with a past expiry needs a new one before saving", () => {
    mount({ ...PREFILL, expiresAt: "2020-01-01T00:00:00.000Z" });
    for (const label of ["No expiry", "For 24 hours", "Until…"]) {
      expect(row(label).querySelector("[aria-label=Selected]")).toBeNull();
    }
    expect(
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.disabled
    ).toBe(true);
    act(() => row("No expiry").click());
    expect(done().disabled).toBe(false);
  });

  it("Done stays enabled when a locked chat is the only notifier", () => {
    mount({ ...PREFILL, notifiers: [{ key: "chat:chat_9:user_2", label: "This chat" }] });
    next();
    expect(done().disabled).toBe(false);
    expect(card()!.querySelector("[role=alert]")).toBeNull();
  });

  it("a project chat row is a normal toggle", () => {
    mount({ ...PREFILL, notifiers: [{ key: "chat:project:-", label: "This chat" }] });
    next();
    const project = row("Project chat");
    expect(project.disabled).toBe(false);
    expect(project.getAttribute("aria-pressed")).toBe("true");
    act(() => project.click());
    expect(row("Project chat").getAttribute("aria-pressed")).toBe("false");
  });

  it("a deleted channel is not listed and is dropped on save", async () => {
    mount({
      ...PREFILL,
      notifiers: [...PREFILL.notifiers, { key: "channel:dead", label: "Deleted channel" }],
    });
    next();
    expect(card()!.textContent).not.toContain("Deleted channel");
    act(() => done().click());
    await flush();
    await flush();
    expect(Object.fromEntries(posted[0]!)).toEqual({
      intent: "edit",
      notifierIds: "chat:chat_9:user_2,channel:ch_1",
      respond: "json",
      expiresAt: "none",
    });
  });

  it("the add channel row reads Add channel… with no icon", () => {
    mount(PREFILL, { canWrite: true, atLimit: false } as any);
    next();
    const add = row("Add channel…");
    expect(add).toBeDefined();
    expect(add.querySelectorAll("svg")).toHaveLength(0);
  });

  it("closing keeps the edits and offers Continue editing", () => {
    mount();
    next();
    act(() => row("Email to ops").click());
    act(() => card()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(card()).toBeNull();
    const resume = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue editing"
    )!;
    act(() => resume.click());
    expect(row("Email to ops").getAttribute("aria-pressed")).toBe("true");
  });
});

describe("activate an inactive alert in the chat", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    posted.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const button = (label: string) =>
    Array.from(card()!.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === label
    )!;

  it("an expired alert opens on an unanswered expiry step", () => {
    mount({ ...PREFILL, activate: true, expiresAt: "2020-01-01T00:00:00.000Z" });
    expect(document.body.textContent).toContain(`Activate ${PREFILL.name}`);
    expect(card()!.textContent).toContain("How long should it stay active?");
    for (const label of ["No expiry", "For 24 hours", "Until…"]) {
      expect(row(label).querySelector("[aria-label=Selected]")).toBeNull();
    }
  });

  it("picking an expiry leads to Activate, which posts the activate intent", async () => {
    mount({ ...PREFILL, activate: true, expiresAt: "2020-01-01T00:00:00.000Z" });
    act(() => row("No expiry").click());
    expect(card()!.textContent).toContain("Watching resumes from now");
    expect(button("Done")).toBeUndefined();
    act(() => button("Activate").click());
    await flush();
    await flush();
    expect(Object.fromEntries(posted[0]!)).toEqual({
      intent: "activate",
      respond: "json",
      notifierIds: "chat:chat_9:user_2,channel:ch_1",
      expiresAt: "none",
    });
    expect(document.querySelector('[data-testid="edit-flow"]')!.textContent).toContain(
      "Activated."
    );
  });

  it("an alert without expiry keeps No expiry preselected", () => {
    mount({ ...PREFILL, activate: true, expiresAt: null });
    expect(row("No expiry").querySelector("[aria-label=Selected]")).not.toBeNull();
  });
});

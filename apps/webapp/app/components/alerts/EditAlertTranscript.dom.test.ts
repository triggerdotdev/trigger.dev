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
  notifiers: [{ key: "channel:ch_1", label: "Ops webhook" }],
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

const saveButton = () =>
  Array.from(card()!.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === "Save"
  )!;

const save = () => {
  act(() => done().click());
  act(() => saveButton().click());
};

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
    expect(card()?.textContent).toContain("1 of 3");
    expect(card()?.textContent).toContain("How long should it stay active?");
    expect(
      Array.from(card()!.querySelectorAll("button")).some((b) => b.textContent === "Skip")
    ).toBe(false);
    expect(row("No expiry").querySelector("[aria-label=Selected]")).not.toBeNull();
    next();
    expect(card()?.textContent).toContain("2 of 3");
    expect(card()?.textContent).not.toContain("What would you like me to watch?");
    expect(card()?.textContent).not.toContain("Recurring");
    expect(row("Ops webhook").getAttribute("aria-pressed")).toBe("true");
    expect(row("Email to ops").getAttribute("aria-pressed")).toBe("false");
  });

  it("Done posts notifiers to the edit action and shows Updated", async () => {
    mount();
    next();
    act(() => row("Email to ops").click());
    act(() => done().click());
    const nameInput = card()!.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(nameInput.value).toBe(PREFILL.name);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        nameInput,
        "Renamed"
      );
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        nameInput,
        ""
      );
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(saveButton().disabled).toBe(true);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        nameInput,
        "Renamed"
      );
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => saveButton().click());
    await flush();
    await flush();
    expect(posted).toHaveLength(1);
    expect(Object.fromEntries(posted[0]!)).toEqual({
      intent: "edit",
      name: "Renamed",
      notifierIds: "channel:ch_1,channel:ch_2",
      respond: "json",
      expiresAt: "none",
    });
    expect(card()).toBeNull();
    const transcript = document.querySelector('[data-testid="edit-flow"]')!;
    expect(transcript.textContent).toContain("Updated.");
    const updated = document.querySelector('[data-testid="alert-updated"]')!;
    expect(updated.textContent).toContain("Watch");
    expect(updated.textContent).toContain("View alert");
    expect(updated.textContent).toContain("Notifying: Ops webhook, Email to ops.");
  });

  it("a group opens on the any/all step and posts the chosen compositeMode", async () => {
    mount({ ...PREFILL, compositeMode: "any" });
    expect(card()?.textContent).toContain("1 of 4");
    expect(row("Any alert fires").querySelector("[aria-label=Selected]")).not.toBeNull();
    act(() => row("All alerts fire").click());
    expect(card()?.textContent).toContain("2 of 4");
    next();
    save();
    await flush();
    await flush();
    expect(Object.fromEntries(posted[0]!).compositeMode).toBe("all");
  });

  it("unchanged notifiers send no notifier list", async () => {
    mount();
    next();
    save();
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
    save();
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

  it("legacy chat notifiers are not rendered and are dropped on save", async () => {
    mount({
      ...PREFILL,
      notifiers: [
        ...PREFILL.notifiers,
        { key: "chat:chat_9:user_2", label: "This chat" },
        { key: "chat:project:-", label: "This chat" },
      ],
    });
    next();
    expect(card()!.textContent).not.toMatch(/chat/i);
    act(() => done().click());
    act(() => saveButton().click());
    await flush();
    await flush();
    expect(Object.fromEntries(posted[0]!).notifierIds).toBe("channel:ch_1");
  });

  it("a deleted channel is not listed and is dropped on save", async () => {
    mount({
      ...PREFILL,
      notifiers: [...PREFILL.notifiers, { key: "channel:dead", label: "Deleted channel" }],
    });
    next();
    expect(card()!.textContent).not.toContain("Deleted channel");
    save();
    await flush();
    await flush();
    expect(Object.fromEntries(posted[0]!)).toEqual({
      intent: "edit",
      notifierIds: "channel:ch_1",
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
    act(() => button("Done").click());
    expect(card()!.textContent).toContain("Watching resumes from now");
    act(() => button("Activate").click());
    await flush();
    await flush();
    expect(Object.fromEntries(posted[0]!)).toEqual({
      intent: "activate",
      respond: "json",
      notifierIds: "channel:ch_1",
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

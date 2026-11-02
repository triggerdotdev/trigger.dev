// @vitest-environment jsdom
import { createElement, useEffect, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  useCreationFlowState,
  type CreationFlowState,
} from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  useCreationAgentSend,
  type CreationAgentSend,
} from "~/components/dashboard-agent/alert-creation/useCreationAgentSend";
import { type FlowAnswers } from "~/components/dashboard-agent/alert-creation/flow-state";
import { DashboardAgentTurns } from "~/components/dashboard-agent/DashboardAgentMessages";
import { CreationTranscript } from "./CreationTranscript";

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (HTMLElement.prototype as any).scrollIntoView !== "function") {
  (HTMLElement.prototype as any).scrollIntoView = () => {};
}

let container: HTMLElement;
let root: Root;
let flow: CreationFlowState | undefined;
let agent: CreationAgentSend | undefined;
let streaming = false;
const sent = vi.fn();
const resolveGroup = vi.fn(async (id: string) =>
  id === "error_744b4159"
    ? { taskIdentifier: "sync-inventory", fingerprint: "744b4159", label: "sync-inventory · 504" }
    : undefined
);

function Harness({ initial }: { initial?: FlowAnswers }) {
  const state = useCreationFlowState(vi.fn(), initial);
  const send = useCreationAgentSend({
    answers: state.answers,
    onPatchApplied: state.patchAnswers,
    resolveErrorGroup: resolveGroup,
  });
  useEffect(() => {
    flow = state;
    agent = send;
  });
  return createElement(CreationTranscript, {
    flow: state,
    chatId: "chat_1",
    systemLines: send.systemLines,
    agentStreaming: streaming,
    onFreeText: (text: string) => {
      send.handleUserText(text);
      sent(text);
    },
  });
}

function mount(initial?: FlowAnswers) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(ShortcutsProvider, null, createElement(Harness, { initial }))
      )
    )
  );
}

const card = () => document.querySelector<HTMLElement>("[role=dialog]");
const composer = () => document.querySelector<HTMLTextAreaElement>("textarea")!;
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent?.trim() === label
  );

function pick(label: string) {
  const btn = Array.from(card()!.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  );
  if (!btn) throw new Error(`Card option "${label}" not found`);
  act(() => btn.click());
}

function typeAndSend(text: string) {
  const textarea = composer();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

const REPLY =
  "I can't set an expiry relative to a deploy, but 37 hours from now covers the release window for this alert and the rollback after it.\n\nWant me to continue the setup?";

describe("creation card hands off to the chat and back", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    streaming = false;
    sent.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  // Mutation: removing closeCard() from handleComposerSubmit fails this.
  it("sending a message closes the card and keeps the answers", () => {
    mount();
    pick("Queues");
    expect(card()).not.toBeNull();
    typeAndSend("watch depth on the email queue");
    expect(sent).toHaveBeenCalledWith("watch depth on the email queue");
    expect(card()).toBeNull();
    expect(flow!.answers.area).toBe("queues");
  });

  // Mutation: restoring sanitizeDetail in handleTextReply fails this.
  it("shows the user's message and the full reply", () => {
    mount();
    typeAndSend("expire it in 37 hours");
    act(() => agent!.handleTextReply(REPLY));
    const user = document.querySelector('[data-testid="system-line-user"]');
    expect(user?.textContent).toBe("expire it in 37 hours");
    const reply = document.querySelector('[data-testid="system-line-reply"]');
    expect(reply?.textContent).toContain("Want me to continue the setup?");
    expect(reply?.textContent).toContain("the rollback after it.");
  });

  // Mutation: dropping the Continue setup gate or the patch application fails this.
  it("Continue setup reopens the card with the patch applied", () => {
    mount();
    pick("Queues");
    typeAndSend("depth over 250 on all queues");
    streaming = true;
    mount();
    expect(button("Continue setup")).toBeUndefined();
    act(() =>
      agent!.handleDraftPatches([
        {
          ok: true,
          patch: { what: "queue.depth", scope: { type: "all" }, condition: { value: 250 } },
        },
      ])
    );
    act(() => agent!.handleTextReply("Set to 250. Want me to continue the setup?"));
    streaming = false;
    mount();
    const resume = button("Continue setup");
    expect(resume).toBeDefined();
    act(() => resume!.click());
    expect(flow!.answers).toMatchObject({
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "250",
    });
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
  });

  // Mutation: keeping awaitingReply set on an error line fails this.
  it("a failed send clears the thinking row and offers Continue setup", () => {
    mount();
    pick("Queues");
    typeAndSend("depth over 250");
    expect(document.body.textContent).toContain("Thinking");
    expect(button("Continue setup")).toBeUndefined();
    act(() => agent!.handleError("We couldn't open that chat. Try again in a moment."));
    expect(document.querySelector('[data-testid="system-line-error"]')?.textContent).toBe(
      "We couldn't open that chat. Try again in a moment."
    );
    expect(document.body.textContent).not.toContain("Thinking");
    expect(button("Continue setup")).toBeDefined();
  });

  // Mutation: dropping the waiting guard in handleComposerSubmit fails this.
  it("a second message while the first is pending stays in the composer", () => {
    mount();
    typeAndSend("first");
    typeAndSend("second");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(composer().value).toBe("second");
  });

  // Mutation: dropping the Nh branch from expiryDate empties the date field.
  it("a patched 37h expiry shows the Until date row selected", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T10:00:00Z") });
    mount({ area: "queues", what: "queue.depth", scope: "all", condition: "100" });
    act(() => agent!.handleDraftPatches([{ ok: true, patch: { behavior: { expiry: "37h" } } }]));
    expect(flow!.answers.expiry).toBe("37h");
    act(() => button("Customize")!.click());
    for (let i = 0; i < 4; i++) {
      act(() =>
        card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.click()
      );
    }
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
    const at = new Date("2026-10-08T23:00:00Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const group = card()!.querySelector<HTMLElement>('[role="group"]')!;
    expect(group.closest("li")!.querySelector('[aria-label="Selected"]')).not.toBeNull();
    const segments = Array.from(group.querySelectorAll<HTMLElement>('[role="spinbutton"]'));
    expect(segments.map((s) => s.lastElementChild?.textContent)).toEqual([
      pad(at.getDate()),
      pad(at.getMonth() + 1),
      String(at.getFullYear()),
      pad(at.getHours()),
      pad(at.getMinutes()),
    ]);
    const segment = segments[0]!;
    act(() => {
      segment.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(flow!.answers.expiry).toBe("37h");
    expect(card()?.getAttribute("aria-label")).toBe("Where should it notify you?");
  });

  // Mutation: handing Until… off to the composer removes the date field from the card.
  it("Until… reveals the date field inside the card", () => {
    mount({ area: "queues", what: "queue.depth", scope: "all", condition: "100" });
    pick("Until…");
    expect(card()).not.toBeNull();
    expect(card()!.querySelector('[role="group"] [role="spinbutton"]')).not.toBeNull();
    expect(card()!.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(composer().placeholder).toBe("Ask anything…");
  });

  // Mutation: dropping awaitingReply from `waiting` hides the indicator and shows the button early.
  it("shows the thinking row, not Continue setup, until the reply lands", () => {
    mount();
    pick("Queues");
    typeAndSend("watch depth on the email queue");
    expect(document.body.textContent).toContain("Thinking…");
    expect(button("Continue setup")).toBeUndefined();
    act(() => agent!.handleTextReply("Which queue? Or shall we continue the setup?"));
    expect(document.body.textContent).not.toContain("Thinking…");
    expect(button("Continue setup")).toBeDefined();
  });

  // Mutation: removing the progress row from DashboardAgentTurns fails this.
  it("the normal chat still shows its in-flight indicator", () => {
    act(() =>
      root.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
          createElement(
            ShortcutsProvider,
            null,
            createElement(DashboardAgentTurns, {
              messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
              activity: "thinking",
              onIntent: () => {},
            })
          )
        )
      )
    );
    expect(container.textContent).toContain("Thinking…");
  });

  // Mutation: removing the errorGroup lookup in handleDraftPatches leaves the scope empty.
  it("an error patch from chat answers area, what and the error; Continue opens at expiry", async () => {
    mount();
    pick("Errors");
    typeAndSend("alert me if error_744b4159 happens again");
    await act(async () => {
      agent!.handleDraftPatches([
        {
          ok: true,
          patch: {
            area: "errors",
            what: "errors.occurred_again",
            scope: { type: "errorGroup", errorId: "error_744b4159" },
          },
        },
      ]);
      await Promise.resolve();
    });
    act(() => agent!.handleTextReply("Set. Shall we continue the setup?"));
    expect(resolveGroup).toHaveBeenCalledWith("error_744b4159");
    expect(flow!.answers).toMatchObject({
      area: "errors",
      what: "errors.occurred_again",
      scope: "errorGroup",
      scopeValue: "sync-inventory#744b4159",
    });
    act(() => button("Continue setup")!.click());
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
    expect(card()?.textContent).toContain("4 of 6");
  });

  // Mutation: dropping the selected check from hasNext lets Next pass an unanswered step.
  it("Next is blocked on an unanswered step, Back is not", () => {
    mount();
    pick("Queues");
    const nav = (label: string) =>
      card()!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(nav("Next question").disabled).toBe(true);
    expect(nav("Previous question").disabled).toBe(false);
    act(() => nav("Previous question").click());
    expect(nav("Next question").disabled).toBe(false);
    act(() => nav("Next question").click());
    expect(nav("Next question").disabled).toBe(true);
  });
});

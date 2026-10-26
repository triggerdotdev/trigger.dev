// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { alertKindSchema } from "@internal/alert-contracts";
import { ScopeTypeSchema } from "~/v3/services/alerts/alertDraft";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  useCreationFlowState,
  type AlertChannel,
  type CreationFlowState,
} from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  areaChips,
  capabilityChips,
  promptForStep,
  resolveCapability,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { CreationTranscript } from "./CreationTranscript";

vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => ({ slug: "proj" }) }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => ({ slug: "dev" }) }));

const ENTITIES: Record<string, unknown> = {
  queues: {
    queues: [
      { name: "email-queue", type: "custom" },
      { name: "billing-queue", type: "custom" },
    ],
    hasMore: false,
  },
  tasks: { tasks: [{ slug: "send-email" }, { slug: "nightly-report" }] },
};
globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
  const kind = String(url).match(/\/(queues|tasks)(\?|$)/)?.[1];
  return new Response(JSON.stringify(kind ? ENTITIES[kind] : {}));
}) as typeof fetch;

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

const CHANNEL: AlertChannel = { id: "ch_1", name: "Ops webhook", type: "WEBHOOK" };

let container: HTMLElement;
let root: Root;
let latest: CreationFlowState | undefined;
const freeText = vi.fn();
let withComposer = true;

function Harness({
  onSubmit,
  chatId,
  initial,
}: {
  onSubmit: (a: FlowAnswers) => void;
  chatId?: string;
  initial?: FlowAnswers;
}) {
  const flow = useCreationFlowState(onSubmit, initial);
  // eslint-disable-next-line -- test harness captures the hook return
  latest = flow;
  return createElement(CreationTranscript, {
    flow,
    channels: [CHANNEL],
    chatId,
    onFreeText: withComposer ? freeText : undefined,
  });
}

function mount(
  onSubmit: (a: FlowAnswers) => void = vi.fn(),
  chatId?: string,
  initial?: FlowAnswers
) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(Harness, { onSubmit, chatId, initial })
        )
      )
    )
  );
}

const card = () => document.querySelector<HTMLElement>("[role=dialog]");
const cardRows = () =>
  Array.from(card()?.querySelectorAll<HTMLButtonElement>("li > button") ?? [])
    .map((b) => b.textContent)
    .filter((text) => text !== "Something else");

function pick(label: string) {
  const btn = Array.from(card()!.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  );
  if (!btn) throw new Error(`Card option "${label}" not found`);
  act(() => btn.click());
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const done = () =>
  Array.from(card()!.querySelectorAll("button")).find((b) => b.textContent === "Done")!;

function reviewButton(label: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => !card()?.contains(b) && b.textContent === label
  )!;
}

function enter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function arrowUp(segment: HTMLElement) {
  act(() => {
    segment.focus();
    segment.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  });
}

async function openQueueDropdown() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const select = card()!.querySelector<HTMLButtonElement>('button[aria-label="Queue"]')!;
  act(() => {
    select.focus();
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return select;
}

function toNotifiers() {
  toStageB();
  pick("100");
  pick("All queues");
  pick("No expiry");
}

function toStageB() {
  pick("Queues");
  pick("Depth getting too high");
}

describe("wizard card drives step-by-step creation", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    freeText.mockClear();
    withComposer = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("stage A card asks for the area with 5 options and no chips row", () => {
    mount();
    expect(card()?.getAttribute("aria-label")).toBe("What would you like me to watch?");
    expect(cardRows()).toEqual(["Queues", "Runs", "Health", "Errors", "Show me what I can watch"]);
    const outside = Array.from(document.querySelectorAll("button")).filter(
      (b) => !card()!.contains(b) && b.textContent?.trim() === "Queues"
    );
    expect(outside).toHaveLength(0);
  });

  it("selecting an area advances the card to the capability options", () => {
    mount();
    pick("Queues");
    expect(latest!.answers.area).toBe("queues");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("what", { area: "queues" }));
    expect(card()?.textContent).toContain("2 of 5");
  });

  // Mutation: restoring curatedOnly or the More metrics toggle fails this.
  it("the what step lists every capability with no More metrics row", () => {
    mount();
    pick("Queues");
    const all = capabilityChips("queues").map((c) => c.label);
    expect(cardRows()).toEqual([...all, "Show me what I can watch"]);
    expect(cardRows()).not.toContain("More metrics");
  });

  // Mutation: dropping the description tooltip from scenario rows fails this.
  // Mutation: re-adding queuePattern or the Specific queue row to the card fails this.
  it("scope offers all queues and the queue dropdown, no Specific row or pattern", () => {
    mount();
    pick("Queues");
    pick("Depth getting too high");
    pick("100");
    expect(cardRows()).toEqual(["All queues"]);
    expect(card()!.querySelector('button[aria-label="Queue"]')).not.toBeNull();
  });

  it("navigation goes back freely, forward only over answered steps, and keeps answers", () => {
    mount();
    toStageB();
    pick("100");
    pick("All queues");
    const nav = (label: string) =>
      act(() => card()!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    nav("Previous question");
    nav("Previous question");
    nav("Previous question");
    nav("Previous question");
    expect(card()?.getAttribute("aria-label")).toBe("What would you like me to watch?");
    nav("Next question");
    nav("Next question");
    nav("Next question");
    nav("Next question");
    expect(card()?.textContent).toContain("5 of 6");
    expect(
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.disabled
    ).toBe(true);
    expect(latest!.answers).toMatchObject({ area: "queues", what: "queue.depth", scope: "all" });
  });

  // Mutation: dropping the explicit past-date check stores the date.
  it("a past Until date shows an error and stores nothing", () => {
    withComposer = false;
    mount();
    toStageB();
    pick("100");
    pick("All queues");
    pick("Until…");
    const segments = Array.from(card()!.querySelectorAll<HTMLElement>('[role="spinbutton"]'));
    for (const segment of segments) arrowUp(segment);
    act(() => {
      segments[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(latest!.answers.expiry).toBeUndefined();
    expect(card()!.textContent).toContain("Must be in the future");
    expect(
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.disabled
    ).toBe(true);
  });

  // Mutation: dropping autoFocus leaves focus on the Until row.
  // Mutation: keeping `revealed` after another row is picked leaves the date field open.
  it("Until… focuses the day segment and another row swaps the date field back", () => {
    withComposer = false;
    mount();
    toStageB();
    pick("100");
    pick("All queues");
    pick("Until…");
    const segments = Array.from(card()!.querySelectorAll<HTMLElement>('[role="spinbutton"]'));
    expect(segments[0]!.getAttribute("aria-label")).toContain("day");
    expect(document.activeElement).toBe(segments[0]);
    pick("For 24 hours");
    expect(latest!.answers.expiry).toBe("24h");
    act(() =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')!.click()
    );
    expect(card()!.querySelector('[role="spinbutton"]')).toBeNull();
    expect(cardRows()).toContain("Until…");
  });

  // Mutation: dropping the clear on Until… keeps the old expiry answered.
  it("switching from No expiry to Until… unsets the expiry", () => {
    withComposer = false;
    mount();
    toStageB();
    pick("100");
    pick("All queues");
    pick("No expiry");
    expect(latest!.answers.expiry).toBe("none");
    act(() =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')!.click()
    );
    pick("Until…");
    expect(latest!.answers.expiry).toBeUndefined();
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
    expect(
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.disabled
    ).toBe(true);
  });

  // Mutation: restoring the datetime-local input fails this.
  it("Until… replaces its row with a dd/mm/yyyy 24h date field that stores ISO on Enter", () => {
    withComposer = false;
    mount();
    toStageB();
    pick("100");
    pick("All queues");
    expect(card()!.querySelector('[role="group"]')).toBeNull();
    pick("Until…");
    expect(card()!.querySelector('input[type="datetime-local"]')).toBeNull();
    const group = card()!.querySelector<HTMLElement>('[role="group"]')!;
    const segments = Array.from(group.querySelectorAll<HTMLElement>('[role="spinbutton"]'));
    expect(segments.length).toBeGreaterThanOrEqual(5);
    expect(cardRows()).not.toContain("Until…");
    for (const segment of segments) arrowUp(segment);
    arrowUp(segments[2]!);
    expect(card()!.textContent).not.toContain("Set");
    // Mutation: storing the date as it changes fails this.
    expect(latest!.answers.expiry).toBeUndefined();
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
    const confirm = group.closest("li")!.querySelector('button[aria-label="Confirm"]')!;
    expect(confirm.className).not.toContain("invisible");
    act(() => {
      segments[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const expiry = latest!.answers.expiry!;
    expect(new Date(expiry).toISOString()).toBe(expiry);
    expect(Date.parse(expiry)).toBeGreaterThan(Date.now());
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("notifiers", {}));
  });

  // Mutation: confirmNotifiers jumping straight to review fails this.
  it("confirming notifiers with the area unanswered lands on the area", () => {
    mount();
    act(() => latest!.toggleNotifier("ch_1"));
    act(() => latest!.confirmNotifiers());
    expect(latest!.isReview).toBe(false);
    expect(latest!.currentStep).toBe("area");
  });

  it("after scope stage B opens with no interim renders behind it", () => {
    mount();
    toStageB();
    expect(document.querySelector('[data-testid^="frozen-step-"]')).toBeNull();
    const transcript = document.querySelector('[data-testid="creation-flow"]')!;
    expect(transcript.querySelectorAll("button, input")).toHaveLength(0);
    expect(transcript.textContent).toBe("Create a new alert");
    expect(card()?.textContent).toContain("3 of 6");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("condition", latest!.answers));
    expect(cardRows()).toEqual(["50", "100", "200", "Custom"]);
  });

  it("Done shows the review card without creating; Create creates once", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit);
    toNotifiers();
    expect(done().disabled).toBe(true);
    pick("Ops webhook");
    expect(latest!.answers.notifiers).toEqual(["ch_1"]);
    act(() => done().click());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(latest!.isReview).toBe(true);
    expect(card()).toBeNull();
    await act(async () => reviewButton("Create alert").click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latest!.created).toBe(true);
  });

  it("Customize reopens the wizard at the area with previous picks selected", () => {
    mount();
    toNotifiers();
    pick("Ops webhook");
    act(() => done().click());
    act(() => reviewButton("Customize").click());
    expect(card()?.getAttribute("aria-label")).toBe("What would you like me to watch?");
    expect(card()?.textContent).toContain("1 of 6");
    const queues = Array.from(card()!.querySelectorAll("li button")).find(
      (b) => b.textContent === "Queues"
    )!;
    expect(queues.querySelector('[aria-label="Selected"]')).not.toBeNull();
    pick("Queues");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("what", { area: "queues" }));
    expect(latest!.answers.notifiers).toEqual(["ch_1"]);
    expect(latest!.isReview).toBe(true);
  });

  // Mutation: clearing the condition on every keystroke remounts the card and drops the input.
  it("retyping a committed custom threshold in Customize keeps the input and commits it", () => {
    const onSubmit = vi.fn();
    mount(onSubmit);
    toStageB();
    pick("Custom");
    const input = () => card()!.querySelector<HTMLInputElement>("input")!;
    type(input(), "137");
    enter(input());
    pick("All queues");
    pick("No expiry");
    pick("Ops webhook");
    act(() => done().click());
    act(() => reviewButton("Customize").click());
    pick("Queues");
    pick("Depth getting too high");
    const first = input();
    expect(first.value).toBe("137");
    type(first, "");
    type(first, "5");
    type(first, "50");
    expect(input()).toBe(first);
    enter(first);
    expect(latest!.answers.condition).toBe("50");
  });

  it("This chat can be deselected and Done then disables", () => {
    mount(vi.fn(), "chat_1");
    toNotifiers();
    expect(latest!.answers.notifiers).toEqual(["chat"]);
    expect(done().disabled).toBe(false);
    pick("This chat");
    const chat = Array.from(card()!.querySelectorAll("li button")).find(
      (b) => b.textContent === "This chat"
    )!;
    expect(chat.getAttribute("aria-pressed")).toBe("false");
    expect(latest!.answers.notifiers).toEqual([]);
    expect(done().disabled).toBe(true);
    expect(card()!.querySelector("[role=alert]")?.textContent).toBe(
      "Pick at least one destination."
    );
  });

  it("a draft without notifiers blocks Create and Customize opens the notifiers step", () => {
    const onSubmit = vi.fn();
    mount(onSubmit, undefined, {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      expiry: "none",
    });
    expect(latest!.isReview).toBe(true);
    expect(reviewButton("Create alert").disabled).toBe(true);
    expect(document.body.textContent).toContain("Pick at least one destination.");
    act(() => reviewButton("Customize").click());
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("notifiers", {}));
    pick("Ops webhook");
    act(() => done().click());
    expect(reviewButton("Create alert").disabled).toBe(false);
    act(() => reviewButton("Create alert").click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Customize hands back to the flow on a different pick and needs Done again", () => {
    mount();
    toNotifiers();
    pick("Ops webhook");
    act(() => done().click());
    act(() => reviewButton("Customize").click());
    pick("Queues");
    pick("Oldest run waiting too long");
    expect(latest!.isReview).toBe(false);
    expect(latest!.answers.what).toBe("queue.oldest_age");
    expect(latest!.answers.scope).toBe("all");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("condition", latest!.answers));
    pick("1,000ms");
    expect(latest!.isReview).toBe(false);
    act(() => done().click());
    expect(latest!.isReview).toBe(true);
    expect(reviewButton("Create alert")).toBeDefined();
  });

  it("closing the card in edit mode returns to the review card", () => {
    mount();
    toNotifiers();
    pick("Ops webhook");
    act(() => done().click());
    act(() => reviewButton("Customize").click());
    expect(reviewButton("Create alert")).toBeUndefined();
    act(() => card()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(card()).toBeNull();
    expect(reviewButton("Create alert")).toBeDefined();
    expect(latest!.isReview).toBe(true);
  });

  it("review shows only the message and the Watch card", () => {
    mount();
    toNotifiers();
    pick("Ops webhook");
    act(() => done().click());
    const transcript = document.querySelector('[data-testid="creation-flow"]')!;
    expect(transcript.querySelector('[data-testid^="frozen-step-"]')).toBeNull();
    expect(transcript.textContent).not.toContain("What would you like me to watch?");
    const turns = transcript.querySelectorAll(":scope > *");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.textContent).toContain(
      "That's everything I need. The alert below is what I'll create — create it when you're happy, or keep changing it in words."
    );
    expect(turns[1]!.textContent).toContain("Watch");
    expect(turns[1]!.textContent).not.toContain("Alert");
  });

  it("Start over resets to the first card", () => {
    mount();
    toNotifiers();
    pick("Ops webhook");
    act(() => done().click());
    act(() => reviewButton("Start over").click());
    expect(latest!.answers).toEqual({});
    expect(card()?.getAttribute("aria-label")).toBe("What would you like me to watch?");
    expect(card()?.textContent).toContain("1 of 5");
  });

  it("no stage offers Skip", () => {
    mount();
    const seen: string[] = [];
    const record = () => seen.push(card()?.textContent ?? "");
    record();
    pick("Queues");
    record();
    pick("Depth getting too high");
    record();
    pick("100");
    record();
    pick("All queues");
    record();
    pick("No expiry");
    record();
    expect(seen.some((text) => text.includes("Something else"))).toBe(false);
    expect(seen.some((text) => text.includes("Skip"))).toBe(false);
  });

  it("stale notifier ids keep Done disabled", () => {
    mount();
    toStageB();
    pick("100");
    pick("All queues");
    pick("No expiry");
    act(() => latest!.toggleNotifier("deleted-id"));
    expect(latest!.answers.notifiers).toEqual(["deleted-id"]);
    const done = Array.from(card()!.querySelectorAll("button")).find(
      (b) => b.textContent === "Done"
    )!;
    expect(done.disabled).toBe(true);
    expect(card()!.querySelector("[role=alert]")?.textContent).toBe(
      "Pick at least one destination."
    );
  });

  it("re-picking the current value keeps downstream answers", async () => {
    mount();
    pick("Queues");
    pick("Depth getting too high");
    pick("100");
    await openQueueDropdown();
    act(() => document.querySelectorAll<HTMLElement>("[role=option]")[0]!.click());
    expect(latest!.answers.scope).toBe("queue");
    act(() =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')!.click()
    );
    pick("100");
    expect(latest!.answers.scope).toBe("queue");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("scope", latest!.answers));
  });

  it("Escape in the composer closes the card", () => {
    mount();
    const composer = document.querySelector<HTMLTextAreaElement>("textarea[data-agent-composer]")!;
    composer.focus();
    act(() => {
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(card()).toBeNull();
  });

  it("Show me what I can watch lists every scenario and lands on the condition", () => {
    mount();
    pick("Show me what I can watch");
    expect(freeText).not.toHaveBeenCalled();
    expect(card()?.getAttribute("aria-label")).toBe("What can I watch?");
    const expected = areaChips().flatMap((area) =>
      capabilityChips(area.value).map((chip) => `${area.label} · ${chip.label}`)
    );
    expect(cardRows()).toEqual(expected);
    pick("Runs · Runs taking too long");
    expect(latest!.answers.area).toBe("runs");
    expect(latest!.answers.what).toBe("runs.duration_p95");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("condition", latest!.answers));
  });

  it("custom threshold is typed inside the card", () => {
    mount();
    toStageB();
    expect(card()!.querySelector("input[type=number]")).toBeNull();
    pick("Custom");
    const input = card()!.querySelector<HTMLInputElement>("input[type=number]")!;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe("");
    expect(card()!.textContent).not.toContain("Set");
    enter(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.closest("li")!.textContent).toContain("Enter a value");
    expect(latest!.answers.condition).toBeUndefined();
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("condition", latest!.answers));
    type(input, "75");
    enter(input);
    expect(latest!.answers.condition).toBe("75");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("scope", latest!.answers));
  });

  // Mutation: saving on blur again stores the value without a confirm.
  // Mutation: showing the unit before a value is typed fails the first unit check.
  it("a threshold always shows its unit and waits for the arrow", () => {
    mount();
    toStageB();
    pick("Custom");
    const input = card()!.querySelector<HTMLInputElement>("input[type=number]")!;
    const row = input.closest("li")!;
    expect(row.textContent).toContain("runs");
    type(input, "1000");
    expect(row.textContent).toContain("runs");
    expect(row.querySelector('[aria-label="Selected"]')).toBeNull();
    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(latest!.answers.condition).toBeUndefined();
    act(() => row.querySelector<HTMLButtonElement>('button[aria-label="Confirm"]')!.click());
    expect(latest!.answers.condition).toBe("1000");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("scope", latest!.answers));
  });

  it("single-param health capability offers presets from its param", () => {
    mount();
    pick("Health");
    pick("Tasks going silent");
    expect(cardRows()).toEqual(["150s", "300s", "600s", "Custom"]);
    pick("600s");
    expect(latest!.answers.conditionParams).toEqual({ silenceSec: 600 });
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
  });

  // Mutation: dropping the all-params gate on Continue lets one value through.
  it("multi-param health needs every threshold before Continue", () => {
    mount();
    pick("Health");
    pick("Flow health degrading");
    expect(card()?.getAttribute("aria-label")).toBe("When should this alert fire?");
    expect(card()!.textContent).toContain(
      "Fires when any of these values goes above its threshold."
    );
    expect(card()!.textContent).not.toContain("flow health crosses any of these thresholds");
    const field = card()!.querySelector<HTMLInputElement>(
      'input[aria-label="Queued runs threshold"]'
    )!;
    type(field, "abc-1");
    type(field, "-5");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const continueRow = Array.from(card()!.querySelectorAll("li button")).find(
      (b) => b.textContent === "Continue"
    ) as HTMLButtonElement;
    expect(continueRow.disabled).toBe(true);
    type(field, "500");
    expect(latest!.answers.conditionParams).toEqual({ backlogCount: 500 });
    expect(field.value).toBe("500");
    expect(continueRow.disabled).toBe(true);
    pick("Continue");
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("condition", latest!.answers));
    type(
      card()!.querySelector<HTMLInputElement>(
        'input[aria-label="Scheduling delay p95 threshold"]'
      )!,
      "40000"
    );
    expect(latest!.answers.conditionParams).toEqual({
      backlogCount: 500,
      schedulingDelayMs: 40000,
    });
    pick("Continue");
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
  });

  // Mutation: rendering the fields after the options puts Continue above them.
  // Mutation: ticking Continue before every param is set fails the incomplete check.
  it("multi-param Continue is the last row and ticks only when complete", () => {
    mount();
    pick("Health");
    pick("Flow health degrading");
    const rows = () => Array.from(card()!.querySelector("ul")!.children);
    const last = () => rows()[rows().length - 1]!;
    expect(rows()).toHaveLength(3);
    expect(last().textContent).toBe("Continue");
    expect(last().querySelector('[aria-label="Selected"]')).toBeNull();
    const field = (label: string) =>
      card()!.querySelector<HTMLInputElement>(`input[aria-label="${label} threshold"]`)!;
    type(field("Queued runs"), "500");
    expect(field("Queued runs").closest("li")!.textContent).toContain("runs");
    expect(last().querySelector('[aria-label="Selected"]')).toBeNull();
    type(field("Scheduling delay p95"), "40000");
    expect(field("Scheduling delay p95").closest("li")!.textContent).toMatch(/ms$/);
    expect(last().querySelector('[aria-label="Selected"]')).not.toBeNull();
  });

  // Mutation: offering silenceSec in multi-param health steps fails this.
  it("health condition steps do not offer Silence above", () => {
    mount();
    pick("Health");
    pick("Overall health check");
    expect(card()?.getAttribute("aria-label")).toBe("When should this alert fire?");
    expect(card()!.textContent).toContain("Failure rate");
    expect(card()!.textContent).not.toContain("Silence above");
    expect(card()!.querySelector('input[aria-label="Silence threshold"]')).toBeNull();
  });

  // Mutation: leaving the multi-param step's selected empty strands the user on it.
  // Mutation: treating the ticked Continue as a no-op leaves the card on the condition.
  it("filling both params then Continue advances", () => {
    mount();
    pick("Health");
    pick("Flow health degrading");
    const field = (label: string) =>
      card()!.querySelector<HTMLInputElement>(`input[aria-label="${label} threshold"]`)!;
    type(field("Scheduling delay p95"), "40000");
    type(field("Queued runs"), "500");
    const continueRow = Array.from(card()!.querySelectorAll("li > button")).find((b) =>
      b.textContent?.startsWith("Continue")
    )!;
    expect(continueRow.querySelector('[aria-label="Selected"]')).not.toBeNull();
    pick("Continue");
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
    expect(latest!.answers.conditionParams).toEqual({
      schedulingDelayMs: 40000,
      backlogCount: 500,
    });
  });

  // Mutation: dropping setView(undefined) after a pick keeps the card on the re-picked step.
  it("re-picking a different option on an answered step advances", () => {
    mount();
    toStageB();
    pick("100");
    pick("All queues");
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
    for (let i = 0; i < 2; i++) {
      act(() =>
        card()!.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')!.click()
      );
    }
    pick("200");
    expect(latest!.answers.condition).toBe("200");
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
  });

  it("Back from expiry to a multi-param health step, Continue advances", () => {
    mount(vi.fn(), undefined, {
      area: "health",
      what: "health.flow",
      scope: "all",
      conditionParams: { schedulingDelayMs: 60_000, backlogCount: 500 },
      condition: "custom",
    });
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
    act(() =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')!.click()
    );
    expect(
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.disabled
    ).toBe(false);
    pick("Continue");
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
  });

  it("Escape in the custom input keeps the card open", () => {
    mount();
    toStageB();
    pick("Custom");
    const input = card()!.querySelector<HTMLInputElement>("input[type=number]")!;
    input.focus();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(card()?.querySelector("input")).toBeNull();
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("condition", latest!.answers));
  });

  // Mutation: dropping the entity dropdown from the scope step fails this.
  it("a specific queue is picked from the environment's queues", async () => {
    mount();
    pick("Queues");
    pick("Depth getting too high");
    pick("100");
    expect(cardRows()).toEqual(["All queues"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const select = card()!.querySelector<HTMLButtonElement>('button[aria-label="Queue"]')!;
    expect(select.getAttribute("role")).toBe("combobox");
    act(() => {
      select.focus();
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const popover = document.getElementById(select.getAttribute("aria-controls") ?? "")!;
    const options = Array.from(popover.querySelectorAll<HTMLElement>("[role=option]"));
    expect(options.map((o) => o.textContent)).toEqual(["email-queue", "billing-queue"]);
    act(() => options[1]!.click());
    // Mutation: committing on select auto-advances and fails these.
    expect(latest!.answers.scopeValue).toBeUndefined();
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("scope", latest!.answers));
    const row = select.closest("li")!;
    expect(row.querySelector('[aria-label="Selected"]')).not.toBeNull();
    act(() => {
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(latest!.answers).toMatchObject({ scope: "queue", scopeValue: "billing-queue" });
    expect(card()?.getAttribute("aria-label")).toBe("How long should it stay active?");
  });

  it("a specific queue is confirmed with the arrow", async () => {
    mount();
    pick("Queues");
    pick("Depth getting too high");
    pick("100");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const select = card()!.querySelector<HTMLButtonElement>('button[aria-label="Queue"]')!;
    const confirm = () =>
      select.closest("li")!.querySelector<HTMLButtonElement>('button[aria-label="Confirm"]')!;
    expect(confirm().disabled).toBe(true);
    act(() => {
      select.focus();
      select.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const popover = document.getElementById(select.getAttribute("aria-controls") ?? "")!;
    act(() => popover.querySelectorAll<HTMLElement>("[role=option]")[0]!.click());
    expect(latest!.answers.scopeValue).toBeUndefined();
    act(() => confirm().click());
    expect(latest!.answers).toMatchObject({ scope: "queue", scopeValue: "email-queue" });
  });

  // Mutation: dropping the Custom fallback for unmatched agent values fails this.
  it("an agent-set value that matches no queue shows a prefilled Custom row", async () => {
    mount(vi.fn(), undefined, {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: "worker-*",
      condition: "100",
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    act(() =>
      card()!.querySelector<HTMLButtonElement>('button[aria-label="Previous question"]')!.click()
    );
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("scope", latest!.answers));
    expect(card()!.querySelector('button[aria-label="Queue"]')!.textContent).toContain("Custom");
    const input = card()!.querySelector<HTMLInputElement>('input[aria-label="Custom scope"]')!;
    expect(input.value).toBe("worker-*");
  });

  it("clearing an invalid custom input re-enables the preset rows", () => {
    mount();
    pick("Runs");
    pick("Runs going quiet");
    pick("Custom");
    const input = card()!.querySelector<HTMLInputElement>("input[type=number]")!;
    type(input, "5");
    const preset = () =>
      Array.from(card()!.querySelectorAll<HTMLButtonElement>("li button")).find(
        (b) => b.textContent === "30m"
      )!;
    expect(preset().disabled).toBe(true);
    type(input, "");
    expect(preset().disabled).toBe(false);
  });

  it("closing the card keeps the flow and offers Continue setup", () => {
    mount();
    pick("Queues");
    act(() => card()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(card()).toBeNull();
    expect(latest!.answers.area).toBe("queues");
    const resume = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Continue setup"
    );
    expect(resume).toBeDefined();
    act(() => resume!.click());
    expect(card()?.getAttribute("aria-label")).toBe(promptForStep("what", { area: "queues" }));
  });
});

const RequestSchema = z
  .object({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
    environmentId: z.string().min(1),
    chatNotifier: z.enum(["on"]).optional(),
    chatId: z.string().optional(),
    form: z.object({
      capabilityKey: z.string().min(1),
      scopeType: ScopeTypeSchema,
      scopeValue: z.string().optional(),
      conditionKind: alertKindSchema,
      operator: z.enum([">", "<"]).optional(),
      value: z.coerce.number().optional(),
      windowMinutes: z.coerce.number().optional(),
      holdMinutes: z.coerce.number().optional(),
      quietWindowMinutes: z.coerce.number().optional(),
      expiresAt: z.string().optional(),
      notifierChannelIds: z.preprocess((i) => {
        if (typeof i === "string") return i === "" ? [] : [i];
        if (Array.isArray(i)) return i.filter((v) => typeof v === "string" && v !== "");
        return [];
      }, z.string().array()),
    }),
  })
  .refine((v) => v.chatNotifier === "on" || v.form.notifierChannelIds.length > 0, {
    message: "At least one notifier is required",
    path: ["form", "notifierChannelIds"],
  });
if (typeof (globalThis as any).PointerEvent === "undefined") {
  (globalThis as any).PointerEvent = class extends Event {};
}

const flowCapture = { flow: undefined as CreationFlowState | undefined };
const TEST_CHANNEL: AlertChannel = { id: "ch_test", name: "Test Webhook", type: "WEBHOOK" };

function FlowHarness({
  onSubmit,
  channels,
  chatId,
}: {
  onSubmit?: (a: FlowAnswers) => void;
  channels?: AlertChannel[];
  chatId?: string;
}) {
  const flow = useCreationFlowState(onSubmit);
  // eslint-disable-next-line -- test harness captures the hook return
  flowCapture.flow = flow;
  return createElement(CreationTranscript, { flow, channels, chatId });
}

function latestFlow(): CreationFlowState {
  return flowCapture.flow!;
}

function mountFlow(
  onSubmit?: (a: FlowAnswers) => void,
  channels?: AlertChannel[],
  chatId?: string
) {
  act(() => {
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(FlowHarness, { onSubmit, channels, chatId })
        )
      )
    );
  });
}

function findButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text
  ) as HTMLButtonElement | undefined;
}

function pressEnter() {
  const input =
    document.activeElement instanceof HTMLInputElement
      ? document.activeElement
      : document.querySelector<HTMLInputElement>("[role=dialog] input")!;
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function findByTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function openCustomInput() {
  const find = () => document.querySelector<HTMLInputElement>("input[type='number']");
  if (!find()) clickAriaPressed("Custom");
  return find()!;
}

function navigateToNotifiers(value = "100") {
  clickAriaPressed("Queues");
  clickAriaPressed("Depth getting too high");
  const input = openCustomInput();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  pressEnter();
  clickAriaPressed("All queues");
  clickAriaPressed("No expiry");
}

async function navigateToCreated(value = "100", notifier = "Test Webhook") {
  navigateToNotifiers(value);
  clickAriaPressed(notifier);
  clickAriaPressed("Done");
  await clickCreate();
}

async function clickCreate() {
  const btn = findButtonByText("Create alert");
  if (!btn) throw new Error('Chip "Create alert" not found');
  await act(async () => btn.click());
}

function clickAriaPressed(label: string) {
  const btn = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`Chip "${label}" not found`);
  act(() => btn.click());
}

describe("creation flow submission", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("Done POST body parses with RequestSchema and success card renders after 2xx", async () => {
    let capturedBody: unknown;
    const onSubmit = vi.fn((answers: FlowAnswers) => {
      const cap = resolveCapability(answers.what);
      const kind = cap?.allowedKinds[0] ?? "threshold";
      const notifierIds = (answers.notifiers ?? []).filter((n) => n !== "chat");
      capturedBody = {
        organizationId: "org_123",
        projectId: "proj_456",
        environmentId: "env_789",
        chatNotifier: (answers.notifiers ?? []).includes("chat") ? "on" : undefined,
        chatId: "chat_abc",
        form: {
          capabilityKey: answers.what,
          scopeType: answers.scope,
          scopeValue: answers.scopeValue,
          conditionKind: kind,
          operator: kind === "threshold" ? ">" : undefined,
          value: answers.condition ? Number(answers.condition) : undefined,
          windowMinutes: kind === "threshold" ? (answers.windowMinutes ?? 5) : undefined,
          quietWindowMinutes:
            kind === "absence" && answers.condition ? Number(answers.condition) : undefined,
          notifierChannelIds: notifierIds,
        },
      };
    });

    mountFlow(onSubmit, [TEST_CHANNEL]);

    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    const input = openCustomInput();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pressEnter();
    clickAriaPressed("All queues");

    clickAriaPressed("No expiry");
    clickAriaPressed("Test Webhook");
    clickAriaPressed("Done");
    await clickCreate();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const parsed = RequestSchema.safeParse(capturedBody);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.form.windowMinutes).toBeGreaterThan(0);
      expect(parsed.data.form.notifierChannelIds).toContain("ch_test");
    }

    await act(async () => {});
    expect(findByTestId("alert-created")).not.toBeNull();
  });

  it("failed POST keeps no success card (mutation: ignoring result shows success)", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(false));
    mountFlow(onSubmit, [TEST_CHANNEL]);
    await navigateToCreated("50");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestFlow().created).toBe(false);
    expect(findByTestId("alert-created")).toBeNull();
  });

  it("double click on Create calls onSubmit once (mutation: no guard allows two calls)", () => {
    let resolveSubmit: (v: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolveSubmit = r;
        })
    );
    mountFlow(onSubmit, [TEST_CHANNEL]);
    navigateToNotifiers();
    clickAriaPressed("Test Webhook");
    clickAriaPressed("Done");
    const create = findButtonByText("Create alert")!;
    act(() => create.click());
    act(() => create.click());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => resolveSubmit!(true));
  });

  it("Done calls onSubmit with the draft and shows success card (chat stays open)", async () => {
    const onSubmit = vi.fn();
    mountFlow(onSubmit, undefined, "test_chat");

    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    const input = openCustomInput();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "75");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pressEnter();
    clickAriaPressed("All queues");

    clickAriaPressed("No expiry");
    clickAriaPressed("Done");
    await clickCreate();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const draft = onSubmit.mock.calls[0][0] as FlowAnswers;
    expect(draft.area).toBe("queues");
    expect(draft.what).toBe("queue.depth");
    expect(draft.scope).toBe("all");
    expect(draft.condition).toBe("75");
    expect(draft.notifiers).toContain("chat");
    expect(draft.windowMinutes).toBeGreaterThan(0);

    expect(findByTestId("alert-created")).not.toBeNull();
    expect(findByTestId("creation-flow")).not.toBeNull();
  });

  it("notifier step without chatId hides 'This chat', shows only channel chips", () => {
    mountFlow(undefined, [TEST_CHANNEL]);

    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    const input = openCustomInput();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "50");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pressEnter();
    clickAriaPressed("All queues");
    clickAriaPressed("No expiry");

    expect(findButtonByText("This chat")).toBeUndefined();
    expect(findButtonByText("Test Webhook")).toBeDefined();
  });

  it("'This chat' chip is hidden without chatId (mutation: showing it stores empty conversationId)", () => {
    mountFlow(undefined, [TEST_CHANNEL]);
    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    const input = openCustomInput();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pressEnter();
    clickAriaPressed("All queues");
    clickAriaPressed("No expiry");

    expect(latestFlow().currentStep).toBe("notifiers");
    expect(findButtonByText("This chat")).toBeUndefined();
    expect(findButtonByText("Test Webhook")).toBeDefined();
  });

  it("'This chat' is pre-selected and visible at notifiers step (mutation: removing default deselects)", () => {
    mountFlow(undefined, undefined, "chat_test");
    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    const input = openCustomInput();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pressEnter();
    clickAriaPressed("All queues");
    clickAriaPressed("No expiry");

    expect(latestFlow().currentStep).toBe("notifiers");
    expect(latestFlow().answers.notifiers).toContain("chat");
    const chatChip = findButtonByText("This chat");
    expect(chatChip).toBeDefined();
    expect(chatChip!.getAttribute("aria-pressed")).toBe("true");
  });

  it("fails when queue.stalled cannot advance past the condition step", async () => {
    const onSubmit = vi.fn();
    mountFlow(onSubmit, [TEST_CHANNEL]);

    clickAriaPressed("Queues");
    clickAriaPressed("A queue stalling");
    clickAriaPressed("All queues");

    expect(latestFlow().currentStep).toBe("notifiers");

    clickAriaPressed("No expiry");
    expect(latestFlow().currentStep).toBe("notifiers");

    clickAriaPressed("Test Webhook");
    clickAriaPressed("Done");
    await clickCreate();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestFlow().created).toBe(true);
  });
});

const noop = () => {};

const flow = {
  answers: {},
  currentStep: "area",
  completedSteps: [],
  isReview: false,
  created: false,
  createdAlertId: undefined,
  submitting: false,
  submitError: false,
  selectChip: noop,
  setCondition: noop,
  setConditionParams: noop,
  confirmCondition: noop,
  setScopeValue: noop,
  setWindowMinutes: noop,
  toggleNotifier: noop,
  confirmNotifiers: noop,
  setExpiry: noop,
  create: noop,
  reset: noop,
} as unknown as CreationFlowState;

describe("Show me what I can watch", () => {
  it("opens the scenarios card without asking the agent", () => {
    const onFreeText = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          OperatingSystemContextProvider,
          { platform: "mac" },
          createElement(
            ShortcutsProvider,
            null,
            createElement(CreationTranscript, { flow, onFreeText })
          )
        )
      );
    });
    const row = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Show me what I can watch"
    )!;
    act(() => row.click());
    expect(onFreeText).not.toHaveBeenCalled();
    expect(container.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe(
      "What can I watch?"
    );
    act(() => root.unmount());
    container.remove();
  });
});

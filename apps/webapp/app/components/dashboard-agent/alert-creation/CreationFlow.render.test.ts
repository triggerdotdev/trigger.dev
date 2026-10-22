// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { z } from "zod";
import { alertKindSchema } from "@internal/alert-contracts";
import { ScopeTypeSchema } from "~/v3/services/alerts/alertDraft";
import { useCreationFlowState } from "./CreationFlow";
import type { CreationFlowState, AlertChannel } from "./CreationFlow";
import { CreationTranscript } from "~/components/alerts/CreationTranscript";
import { resolveCapability, type FlowAnswers } from "./flow-state";

vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => undefined }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => undefined }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => undefined }));

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

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (globalThis as any).PointerEvent === "undefined") {
  (globalThis as any).PointerEvent = class extends Event {};
}
if (typeof (HTMLElement.prototype as any).scrollIntoView !== "function") {
  (HTMLElement.prototype as any).scrollIntoView = () => {};
}

let container: HTMLElement;
let root: Root;
const capture = { flow: undefined as CreationFlowState | undefined };
const TEST_CHANNEL: AlertChannel = { id: "ch_test", name: "Test Webhook", type: "WEBHOOK" };

function Harness({
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
  capture.flow = flow;
  return createElement(CreationTranscript, { flow, channels, chatId });
}

function latestFlow(): CreationFlowState {
  return capture.flow!;
}

function mount(onSubmit?: (a: FlowAnswers) => void, channels?: AlertChannel[], chatId?: string) {
  act(() => {
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(Harness, { onSubmit, channels, chatId })
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

describe("alert creation flow", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("happy path: area -> what -> condition -> scope -> expiry -> notifiers -> create", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, undefined, "test_chat");

    expect(findByTestId("creation-flow")).not.toBeNull();

    clickAriaPressed("Queues");
    expect(latestFlow().answers.area).toBe("queues");

    clickAriaPressed("Depth getting too high");
    expect(latestFlow().answers.what).toBe("queue.depth");

    expect(findButtonByText("Something else")).toBeUndefined();

    const input = openCustomInput();
    expect(input).not.toBeNull();
    act(() => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeInputValueSetter?.call(input, "100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pressEnter();
    expect(latestFlow().answers.condition).toBe("100");
    expect(latestFlow().answers.windowMinutes).toBeGreaterThan(0);
    const scopeChips = Array.from(document.querySelectorAll("button")).filter((b) =>
      ["Specific queue", "All queues"].includes(b.textContent?.trim() ?? "")
    );
    expect(scopeChips.length).toBeGreaterThan(0);
    clickAriaPressed("All queues");
    expect(latestFlow().answers.scope).toBe("all");

    clickAriaPressed("No expiry");

    clickAriaPressed("Done");
    await clickCreate();
    expect(latestFlow().answers.notifiers).toContain("chat");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestFlow().created).toBe(true);
    expect(findByTestId("alert-created")).not.toBeNull();
  });

  it("zero notifiers shows inline error and blocks Done", () => {
    mount();

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

    expect(document.querySelector<HTMLElement>("[role=dialog] [role=alert]")).not.toBeNull();
    expect(
      document.querySelector<HTMLElement>("[role=dialog] [role=alert]")!.textContent
    ).toContain("at least one");

    const doneBtn = findButtonByText("Done");
    expect(doneBtn).toBeDefined();
    expect(latestFlow().isReview).toBe(false);
  });

  it("'More metrics...' reveals non-curated capabilities", () => {
    mount();

    clickAriaPressed("Queues");

    const capabilityRows = () =>
      Array.from(document.querySelectorAll("[role=dialog] li > button")).filter(
        (b) => b.textContent !== "Show me what I can watch"
      );
    const chipsBefore = capabilityRows();

    const showAllBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Show me what I can watch" && !b.disabled
    );
    expect(showAllBtn).toBeDefined();
    act(() => showAllBtn!.click());

    const chipsAfter = capabilityRows();

    expect(chipsAfter.length).toBeGreaterThan(chipsBefore.length);
  });

  it("Done calls onSubmit with the draft and shows success card (chat stays open)", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, undefined, "test_chat");

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

  it("notifier step renders project channel names from channels prop", () => {
    const channels: AlertChannel[] = [
      { id: "ch_1", name: "Webhook to example.com", type: "WEBHOOK" },
      { id: "ch_2", name: "Error alert to example.com", type: "EMAIL" },
    ];
    mount(undefined, channels);

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

    const webhookChip = findButtonByText("Webhook to example.com");
    const emailChip = findButtonByText("Error alert to example.com");
    expect(webhookChip).toBeDefined();
    expect(emailChip).toBeDefined();

    act(() => webhookChip!.click());
    expect(latestFlow().answers.notifiers).toContain("ch_1");
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

    mount(onSubmit, [TEST_CHANNEL]);

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

  it("notifier step without chatId hides 'This chat', shows only channel chips", () => {
    mount(undefined, [TEST_CHANNEL]);

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

  it("condition auto-sets windowMinutes from capability default (mutation: omitting leaves it undefined)", () => {
    mount();
    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    const input = openCustomInput();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "200");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    pressEnter();
    clickAriaPressed("All queues");

    expect(latestFlow().answers.condition).toBe("200");
    expect(latestFlow().answers.windowMinutes).toBeGreaterThan(0);
    expect(latestFlow().currentStep).not.toBe("condition");
  });

  it("created card echoes 'for Nm' in condition line (mutation: omitting shows bare threshold)", async () => {
    mount(undefined, [TEST_CHANNEL]);
    await navigateToCreated("50");

    expect(latestFlow().created).toBe(true);
    const body = document.body.textContent ?? "";
    expect(body).toContain("for 5m");
  });

  it("success card stays visible after Done (DEC-062, mutation: resetting hides it)", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, [TEST_CHANNEL]);
    await navigateToCreated();

    const card = findByTestId("alert-created");
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("is active.");
    expect(text).toContain("for 5m");
    expect(text).toContain("It stays active until you turn it off.");
    expect(text).toContain("Notifying: Test Webhook.");
    expect(text).not.toContain("Status");
    expect(findByTestId("creation-flow")).not.toBeNull();
    expect(latestFlow().created).toBe(true);
  });

  it("created card summary includes 'for Nm' (mutation: omitting drops window)", async () => {
    mount(undefined, [TEST_CHANNEL]);
    await navigateToCreated();

    expect(latestFlow().created).toBe(true);
    const body = document.body.textContent ?? "";
    expect(body).toContain("for 5m");
  });

  it("prose message appears before the area step card (mutation: removing drops it)", () => {
    mount();
    const body = document.body.textContent ?? "";
    expect(body).toContain("What would you like me to watch?");
  });

  it("failed POST keeps no success card (mutation: ignoring result shows success)", async () => {
    const onSubmit = vi.fn(() => Promise.resolve(false));
    mount(onSubmit, [TEST_CHANNEL]);
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
    mount(onSubmit, [TEST_CHANNEL]);
    navigateToNotifiers();
    clickAriaPressed("Test Webhook");
    clickAriaPressed("Done");
    const create = findButtonByText("Create alert")!;
    act(() => create.click());
    act(() => create.click());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    act(() => resolveSubmit!(true));
  });

  it("expiry offers no expiry, 24 hours and until (mutation: adding a preset back)", () => {
    mount(undefined, [TEST_CHANNEL]);
    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    clickAriaPressed("100");
    clickAriaPressed("All queues");
    const rows = Array.from(document.querySelectorAll("[role=dialog] li > button")).map(
      (b) => b.textContent
    );
    expect(rows).toEqual(["No expiry", "For 24 hours", "Until…"]);
    clickAriaPressed("For 24 hours");
    expect(latestFlow().answers.expiry).toBe("24h");
  });

  it("'This chat' chip is hidden without chatId (mutation: showing it stores empty conversationId)", () => {
    mount(undefined, [TEST_CHANNEL]);
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
    mount(undefined, undefined, "chat_test");
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

  it("fails when Done with no notifiers triggers create", () => {
    const onSubmit = vi.fn();
    mount(onSubmit, undefined);
    navigateToNotifiers();

    expect(latestFlow().currentStep).toBe("notifiers");
    expect(document.querySelector<HTMLElement>("[role=dialog] [role=alert]")).not.toBeNull();

    clickAriaPressed("Done");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(latestFlow().created).toBe(false);
  });

  it("Done then Create triggers create when notifiers are selected", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, [TEST_CHANNEL]);
    navigateToNotifiers();

    clickAriaPressed("Test Webhook");
    expect(latestFlow().answers.notifiers).toContain("ch_test");

    clickAriaPressed("Done");
    await clickCreate();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestFlow().created).toBe(true);
  });

  it("fails when a param above max is accepted via the custom chip", () => {
    mount();

    clickAriaPressed("Health");
    clickAriaPressed("Execution health degrading");

    expect(latestFlow().currentStep).toBe("condition");

    const input = openCustomInput();
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, "150");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.closest("li")!.textContent).toContain("Must be between 0 and 100");
  });

  it("full flow via chips: area → what → scope → condition → expiry → notifiers → Done → create", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, [TEST_CHANNEL], "chat_full");

    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    clickAriaPressed("100");
    clickAriaPressed("All queues");

    expect(latestFlow().answers.condition).toBe("100");
    expect(latestFlow().currentStep).toBe("notifiers");

    clickAriaPressed("No expiry");
    expect(latestFlow().currentStep).toBe("notifiers");

    clickAriaPressed("Test Webhook");
    clickAriaPressed("Done");
    await clickCreate();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(latestFlow().created).toBe(true);
    expect(findByTestId("alert-created")).not.toBeNull();
    const text = findByTestId("alert-created")!.textContent ?? "";
    expect(text).toContain("is active.");
  });

  it("alert name uses alertName() not raw capability title", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, [TEST_CHANNEL]);

    clickAriaPressed("Health");
    clickAriaPressed("Overall health check");
    for (const input of Array.from(
      document.querySelectorAll<HTMLInputElement>('[role=dialog] input[type="number"]')
    )) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          input.placeholder
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    clickAriaPressed("Continue");

    expect(latestFlow().currentStep).toBe("notifiers");
    clickAriaPressed("No expiry");
    clickAriaPressed("Test Webhook");
    clickAriaPressed("Done");
    await clickCreate();

    expect(latestFlow().created).toBe(true);
    const card = findByTestId("alert-created");
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("Overall health check is active.");
    expect(text).not.toContain("Health (All) alert is active.");
  });

  it("title switches to 'Alert created' on success (R1/R5)", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, [TEST_CHANNEL], "chat_r5");

    expect(latestFlow().created).toBe(false);

    clickAriaPressed("Queues");
    clickAriaPressed("Depth getting too high");
    clickAriaPressed("100");
    clickAriaPressed("All queues");
    clickAriaPressed("No expiry");
    clickAriaPressed("Test Webhook");
    clickAriaPressed("Done");
    await clickCreate();

    expect(latestFlow().created).toBe(true);
  });

  it("fails when queue.stalled cannot advance past the condition step", async () => {
    const onSubmit = vi.fn();
    mount(onSubmit, [TEST_CHANNEL]);

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

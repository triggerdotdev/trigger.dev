// @vitest-environment jsdom
import type * as RemixReactModule from "@remix-run/react";
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreationTranscript } from "~/components/alerts/CreationTranscript";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { useCreationFlowState, type AlertChannel, type CreationFlowState } from "./CreationFlow";
import { parseErrorGroupScope } from "~/utils/errorGroupScope";
import { capabilityChips, type FlowAnswers } from "./flow-state";

const fetcherState = vi.hoisted(() => ({
  data: undefined as unknown,
  loads: [] as string[],
  env: "dev",
  routed: false,
}));

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof RemixReactModule>()),
  useInRouterContext: () => fetcherState.routed,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/", search: "" }),
  useFetcher: () => ({
    data: fetcherState.data,
    load: (url: string) => fetcherState.loads.push(url),
  }),
}));
vi.mock("~/hooks/useOrganizations", () => ({
  useOptionalOrganization: () => ({ slug: "org" }),
  useOrganization: () => ({ slug: "org" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useOptionalProject: () => ({ slug: "proj" }),
  useProject: () => ({ slug: "proj" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useOptionalEnvironment: () => ({ slug: fetcherState.env }),
  useEnvironment: () => ({ slug: fetcherState.env }),
}));
vi.mock("~/components/alerts/AlertChannelsBody", () => ({
  AlertChannelsBody: ({ alertChannels }: { alertChannels: { name: string }[] }) =>
    createElement(
      "ul",
      null,
      alertChannels.map((c) => createElement("li", { key: c.name }, c.name))
    ),
}));

const ENTITIES: Record<string, unknown> = {
  queues: {
    queues: [
      { name: "email-queue", type: "custom" },
      { name: "billing-queue", type: "custom" },
    ],
    hasMore: false,
  },
  tasks: { tasks: [{ slug: "send-email" }, { slug: "nightly-report" }] },
  "error-groups": { groups: [{ fingerprint: "fp1", taskIdentifier: "t", label: "t · E" }] },
};
globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
  const kind = String(url).match(/\/(queues|tasks|error-groups)(\?|$)/)?.[1];
  return new Response(JSON.stringify(kind ? ENTITIES[kind] : {}));
}) as typeof fetch;

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

Element.prototype.scrollIntoView ??= () => {};

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const CHANNELS: AlertChannel[] = [
  { id: "ch_1", name: "Ops webhook", type: "WEBHOOK" },
  { id: "ch_2", name: "Email to ops", type: "EMAIL" },
];

let container: HTMLElement;
let root: Root;
let latest: CreationFlowState | undefined;

function Harness({
  manual,
  initial,
  addChannel,
}: {
  manual: boolean;
  initial?: FlowAnswers;
  addChannel?: ComponentProps<typeof CreationTranscript>["addChannel"];
}) {
  const flow = useCreationFlowState(vi.fn(), initial);
  // eslint-disable-next-line -- test harness captures the hook return
  latest = flow;
  return createElement(CreationTranscript, {
    flow,
    channels: CHANNELS,
    chatId: "chat_1",
    manual,
    addChannel,
  });
}

function mount(
  manual: boolean,
  initial?: FlowAnswers,
  addChannel?: ComponentProps<typeof CreationTranscript>["addChannel"]
) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(Harness, { manual, initial, addChannel })
        )
      )
    )
  );
  if (!manual || keepReview) return;
  const customize = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === "Customize"
  );
  if (customize) act(() => customize.click());
}

let keepReview = false;

function remount() {
  act(() => root.unmount());
  root = createRoot(container);
}

const fieldset = (step: string) =>
  document.querySelector<HTMLFieldSetElement>(`fieldset[data-step="${step}"]`)!;
const rowLabels = (scope: Element) =>
  Array.from(
    scope.querySelectorAll<HTMLButtonElement>(
      'li button:not([aria-label^="About "]):not([aria-label="Confirm"])'
    )
  )
    .map((b) => b.textContent ?? "")
    .filter((text) => text !== "Something else" && text !== "Done");
const row = (step: string, label: string) =>
  Array.from(fieldset(step).querySelectorAll<HTMLButtonElement>("li button")).find(
    (b) => b.textContent === label
  )!;
const click = (el: HTMLElement) => act(() => el.click());
const combobox = (step: string) =>
  fieldset(step)?.querySelector<HTMLButtonElement>("button[role=combobox]") ?? null;
const popover = (select: HTMLElement) =>
  document.getElementById(select.getAttribute("aria-controls") ?? "");
const options = (select: HTMLElement) =>
  Array.from(popover(select)?.querySelectorAll<HTMLElement>("[role=option]") ?? []);

const open = (select: HTMLElement) => {
  act(() => select.focus());
  act(() => select.click());
};

const checkboxLabels = (step: string) =>
  Array.from(fieldset(step).querySelectorAll("[data-checkbox-list] label")).map(
    (l) => l.textContent ?? ""
  );
const checkbox = (step: string, label: string) =>
  Array.from(fieldset(step).querySelectorAll<HTMLLabelElement>("[data-checkbox-list] label"))
    .find((l) => l.textContent === label)!
    .querySelector<HTMLInputElement>("input")!;
const checkedLabels = (step: string) =>
  checkboxLabels(step).filter((label) => checkbox(step, label).checked);

function optionLabels(step: string) {
  if (fieldset(step)?.querySelector("[data-checkbox-list]")) return checkboxLabels(step);
  const select = combobox(step);
  if (!select) return rowLabels(fieldset(step));
  open(select);
  const labels = options(select)
    .map((o) => o.textContent ?? "")
    .filter((text) => text !== "Custom");
  act(() => select.click());
  return labels;
}

function pick(step: string, label: string) {
  const select = combobox(step);
  if (!select) return click(row(step, label));
  open(select);
  const found = options(select).find((o) => o.textContent === label);
  if (!found) throw new Error(`no ${label}: ${options(select).map((o) => o.textContent)}`);
  click(found);
}
const chosen = (step: string) => combobox(step)?.textContent;
function allOptionLabels(select: HTMLElement) {
  open(select);
  const labels = options(select).map((o) => o.textContent ?? "");
  act(() => select.click());
  return labels;
}

function tick(step: string, labels: string[]) {
  for (const label of labels) click(checkbox(step, label));
}

const SHOW_ALL = "Show me what I can watch";
const CARD_ONLY_DIFF = [SHOW_ALL, "Custom", "Loading…", "Specific queue", "Specific task"];

function cardLabels(initial: FlowAnswers) {
  mount(false, initial);
  const labels = rowLabels(document.querySelector("[role=dialog]")!);
  remount();
  return labels;
}

const BASE = { area: "queues", what: "queue.depth", scope: "all", condition: "100" } as const;

describe("manual mode shares the wizard steps", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(["queues", "runs", "health"] as const)(
    "%s: every step lists the same options as the card",
    (area) => {
      const what = capabilityChips(area)[0]!.value;
      const card = {
        area: cardLabels({}),
        what: cardLabels({ area }),
        scope: cardLabels({ area, what, condition: "100" }),
      };
      mount(true, { area, what, condition: "100" });
      if (area === "health") {
        expect(fieldset("scope")).toBeNull();
        expect(card.scope).not.toContain("All tasks");
        return;
      }
      for (const [step, labels] of Object.entries(card)) {
        expect(optionLabels(step).filter((label) => !CARD_ONLY_DIFF.includes(label))).toEqual(
          labels.filter((label) => !CARD_ONLY_DIFF.includes(label))
        );
      }
    }
  );

  it("notifiers description opens the channels list in both modes", () => {
    for (const manual of [false, true]) {
      fetcherState.data = {
        alertChannels: [{ name: "Staging pager" }],
        limits: { used: 1, limit: 5 },
        canWrite: true,
      };
      if (manual) mount(true, { ...BASE, expiry: "none" });
      else {
        mount(false, BASE);
        click(
          Array.from(document.querySelectorAll<HTMLButtonElement>("[role=dialog] li button")).find(
            (b) => b.textContent === "No expiry"
          )!
        );
      }
      expect(document.body.textContent).toContain(
        "Only channels enabled for this environment are listed. Missing one? Check the channels list."
      );
      const action = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent === "channels list"
      )!;
      expect(document.body.textContent).not.toContain("Staging pager");
      click(action);
      expect(document.body.textContent).toContain("Staging pager");
      fetcherState.data = undefined;
      remount();
    }
  });

  it("condition, expiry and notifiers list the same options as the card", () => {
    const cardRow = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("[role=dialog] li button")).find(
        (b) => b.textContent === label
      )!;
    const condition = cardLabels({ area: "queues", what: "queue.depth", scope: "all" });
    mount(false, BASE);
    const expiry = rowLabels(document.querySelector("[role=dialog]")!);
    click(cardRow("No expiry"));
    const notifiers = rowLabels(document.querySelector("[role=dialog]")!);
    remount();
    const card = { condition, expiry, notifiers };
    expect(card.notifiers).toEqual(["This chat", "Ops webhook", "Email to ops"]);
    for (const [step, labels] of Object.entries(card)) {
      remount();
      mount(true, { ...BASE, expiry: "none" });
      expect(optionLabels(step)).toEqual(labels.filter((label) => label !== "Custom"));
    }
  });

  it("re-clicking the selected area keeps the downstream answers", () => {
    mount(true, { ...BASE, expiry: "none" });
    pick("area", "Queues");
    expect(latest!.answers).toMatchObject(BASE);
  });

  // Mutation: dropping the entity dropdown from the scope step fails this.
  it("scope is one dropdown: All queues by default plus the environment's queues", async () => {
    mount(true, { area: "queues", what: "queue.depth", condition: "100" });
    await settle();
    const select = combobox("scope")!;
    expect(fieldset("scope").querySelectorAll("button[role=combobox]")).toHaveLength(1);
    expect(select.textContent).toContain("All queues");
    expect(allOptionLabels(select)).toEqual(["All queues", "email-queue", "billing-queue"]);
    expect(fieldset("scope").textContent).not.toContain("Specific");
    open(select);
    click(options(select).find((o) => o.textContent === "email-queue")!);
    expect(latest!.answers).toMatchObject({ scope: "queue", scopeValue: "email-queue" });
    expect(fieldset("scope").querySelector("input")).toBeNull();
    open(combobox("scope")!);
    click(options(combobox("scope")!).find((o) => o.textContent === "All queues")!);
    expect(latest!.answers).toMatchObject({ scope: "all" });
  });

  it("Specific task offers the current tasks and picking one commits it", async () => {
    mount(true, { area: "runs", what: "runs.duration_p95", condition: "1000" });
    await settle();
    const select = combobox("scope")!;
    expect(select.textContent).toContain("All runs");
    expect(allOptionLabels(select)).toContain("nightly-report");
    open(select);
    click(options(select).find((o) => o.textContent === "nightly-report")!);
    expect(latest!.answers).toMatchObject({ scope: "task", scopeValue: "nightly-report" });
  });

  // Mutation: dropping the Custom fallback for unmatched agent values fails this.
  it("an agent-set value that matches no queue shows a prefilled Custom row", async () => {
    mount(true, {
      area: "queues",
      what: "queue.depth",
      condition: "100",
      scope: "queue",
      scopeValue: "worker-*",
    });
    await settle();
    expect(combobox("scope")!.textContent).toContain("Custom");
    const input = fieldset("scope").querySelector<HTMLInputElement>(
      'input[aria-label="Custom scope"]'
    )!;
    expect(input.value).toBe("worker-*");
  });

  it("an agent-set queue pattern shows a prefilled Custom row", () => {
    mount(true, {
      area: "queues",
      what: "queue.depth",
      condition: "100",
      scope: "queuePattern",
      scopeValue: "worker-*",
    });
    expect(chosen("scope")).toContain("Custom");
    expect(
      fieldset("scope").querySelector<HTMLInputElement>('input[aria-label="Custom scope"]')!.value
    ).toBe("worker-*");
  });

  // Mutation: dropping the focus/scroll effect in ManualCreationForm fails this.
  it("picking an area moves focus to the next step", () => {
    const scrolled: Element[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
    try {
      mount(true);
      expect(fieldset("what")).toBeNull();
      pick("area", "Runs");
      expect(latest!.currentStep).toBe("what");
      expect(scrolled).toContain(fieldset("what"));
      expect(document.activeElement).toBe(combobox("what"));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("what lists every capability with no More metrics option", () => {
    mount(true, { area: "queues" });
    const labels = optionLabels("what");
    expect(labels).not.toContain("More metrics");
    expect(labels).toEqual(capabilityChips("queues").map((c) => c.label));
  });

  // Mutation: restoring the datetime-local input fails this.
  it("Until… reveals a date field that stores ISO as soon as it changes", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T10:00:00Z") });
    try {
      mount(true, { ...BASE, expiry: "30h" });
      expect(chosen("expiry")).toContain("Until…");
      expect(fieldset("expiry").querySelector('input[type="datetime-local"]')).toBeNull();
      expect(fieldset("expiry").querySelector('[role="group"] [role="spinbutton"]')).not.toBeNull();
      const hour = fieldset("expiry").querySelectorAll<HTMLElement>('[role="spinbutton"]')[3]!;
      act(() => {
        hour.focus();
        hour.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      });
      expect(latest!.answers.expiry).toBe("2026-10-08T17:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  // Mutation: dropping the clear on Until… keeps the later steps and Create.
  it("switching from No expiry to Until… unsets the expiry and hides later steps", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] });
    expect(fieldset("notifiers")).not.toBeNull();
    pick("expiry", "Until…");
    expect(latest!.answers.expiry).toBeUndefined();
    expect(fieldset("notifiers")).toBeNull();
    expect(latest!.isReview).toBe(false);
  });

  it("picking Until… reveals the date field without setting the expiry", () => {
    mount(true, BASE);
    expect(fieldset("expiry").querySelector('[role="group"]')).toBeNull();
    pick("expiry", "Until…");
    expect(fieldset("expiry").querySelector('[role="group"]')).not.toBeNull();
    expect(latest!.answers.expiry).toBeUndefined();
  });

  it("picking Until… focuses the first date segment", () => {
    mount(true, BASE);
    pick("expiry", "Until…");
    const first = fieldset("expiry").querySelector('[role="group"] [role="spinbutton"]');
    expect(document.activeElement).toBe(first);
  });

  it("revealing the health inputs focuses the first one", () => {
    mount(true, { area: "health" });
    pick("what", "Flow health degrading");
    expect(document.activeElement).toBe(fieldset("condition").querySelector("input"));
  });

  it("notifier select stays in sync with the flow across re-renders", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] });
    expect(checkedLabels("notifiers")).toEqual(["This chat"]);
    tick("notifiers", ["This chat", "Ops webhook"]);
    expect(latest!.answers.notifiers).toEqual(["ch_1"]);
    expect(checkedLabels("notifiers")).toEqual(["Ops webhook"]);
  });

  it("Done shows the Watch review card and Start over resets", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] });
    tick("notifiers", ["This chat", "Ops webhook"]);
    click(
      Array.from(fieldset("notifiers").querySelectorAll("button")).find(
        (b) => b.textContent === "Done"
      )!
    );
    const form = () => document.querySelector('[data-testid="manual-form"]')!;
    expect(latest!.isReview).toBe(true);
    expect(form().textContent).toContain("Watch");
    click(
      Array.from(form().querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent === "Start over"
      )!
    );
    expect(latest!.answers).toEqual({});
  });
});

describe("draft completeness and step order", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Mutation: putting scope back before condition in STEP_ORDER fails this.
  it("asks for the condition before the scope", () => {
    mount(true, { area: "queues", what: "queue.depth" });
    expect(fieldset("condition")).not.toBeNull();
    expect(fieldset("scope")).toBeNull();
    // Mutation: reverting the question or dropping the stem placeholder fails this.
    expect(fieldset("condition").querySelector("legend")!.textContent).toBe(
      "When should this alert fire?"
    );
    expect(combobox("condition")!.textContent).toContain("Select…");
  });

  // Mutation: dropping the condition clear on Custom lets an empty threshold save.
  it("switching the threshold to an empty Custom blocks Done", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] });
    pick("condition", "Custom");
    expect(latest!.answers.condition).toBeUndefined();
    expect(fieldset("notifiers")).toBeNull();
    expect(latest!.isReview).toBe(false);
  });

  // Mutation: restoring the paired grid puts the date beside the dropdown.
  it("puts the date field below the Until dropdown in one column", () => {
    mount(true, { ...BASE, expiry: "30h" });
    const step = fieldset("expiry");
    expect(step.querySelector("[data-control-row]")).toBeNull();
    expect(step.querySelector(".grid-cols-2")).toBeNull();
    const select = step.querySelector("button[role=combobox]")!;
    const group = step.querySelector('[role="group"]')!;
    expect(select.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Mutation: dropping w-full or the grid from the Custom row shrinks the input.
  it("renders the Custom input row as a full-width grid", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] });
    pick("condition", "Custom");
    const input = fieldset("condition").querySelector<HTMLInputElement>("input")!;
    const rowEl = input.closest("li.grid")!;
    expect(rowEl.className).toContain("grid-cols-[minmax(0,1fr)_2.5rem]");
    expect(rowEl.className).toContain("w-full");
    expect(rowEl.className).toContain("max-w-[372px]");
    expect(input.className).toContain("w-full");
  });

  it("sizes every control to a full-width 372px column", async () => {
    mount(true, { area: "queues", what: "queue.depth", condition: "100", scope: "queue" });
    await settle();
    for (const trigger of Array.from(document.querySelectorAll("button[role=combobox]"))) {
      expect(trigger.className).toContain("max-w-[372px]");
      expect(trigger.className).not.toContain("w-[176px]");
    }
  });

  it("never shows a second queue picker or a Specific row", async () => {
    mount(true, { area: "queues", what: "queue.depth", condition: "100", scope: "queue" });
    await settle();
    const triggers = fieldset("scope").querySelectorAll("button[role=combobox]");
    expect(triggers).toHaveLength(1);
    expect(fieldset("scope").textContent).not.toContain("Specific");
    expect(fieldset("scope").querySelector(".grid-cols-2")).toBeNull();
  });

  // Mutation: listing bare task-queue names again makes the page's queue a Custom value.
  it("a queue picked on its page is selected in the picker, not Custom", async () => {
    const queues = ENTITIES.queues;
    ENTITIES.queues = {
      queues: [
        { name: "agent-planner", type: "task" },
        { name: "email-queue", type: "custom" },
      ],
      hasMore: false,
    };
    try {
      mount(true, {
        area: "queues",
        what: "queue.depth",
        condition: "100",
        scope: "queue",
        scopeValue: "task/agent-planner",
      });
      await settle();
      const select = combobox("scope")!;
      expect(select.textContent).toContain("agent-planner");
      expect(select.textContent).not.toContain("Custom");
      expect(fieldset("scope").querySelector('input[aria-label="Custom scope"]')).toBeNull();
    } finally {
      ENTITIES.queues = queues;
    }
  });

  it("shows the selected scenario's description under the dropdown", () => {
    mount(true, { area: "queues", what: "queue.depth" });
    expect(fieldset("what").textContent).toContain(
      "Number of runs waiting in a queue, as a count. Measured as the peak queue length in each evaluation window."
    );
  });
});

describe("manual review lock", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    keepReview = false;
    act(() => root.unmount());
    container.remove();
  });

  const form = () => document.querySelector('[data-testid="manual-form"]')!;
  const button = (label: string) =>
    Array.from(form().querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === label
    );
  const triggers = () =>
    Array.from(form().querySelectorAll<HTMLButtonElement>("button[role=combobox]"));
  const isDisabled = (el: HTMLElement) =>
    el.matches(":disabled") || el.closest("fieldset[disabled]") !== null;

  // Mutation: removing the read-only gate leaves the form editable under the review card.
  it("locks the form while the review card is shown and Customize unlocks it", async () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] });
    await settle();
    click(button("Done")!);
    keepReview = true;
    expect(latest!.isReview).toBe(true);
    expect(triggers().length).toBeGreaterThan(1);
    for (const trigger of triggers()) expect(isDisabled(trigger)).toBe(true);
    expect(button("Done")).toBeUndefined();
    click(button("Customize")!);
    expect(form().textContent).not.toContain("Create alert");
    for (const trigger of triggers()) expect(isDisabled(trigger)).toBe(false);
    expect(button("Done")).toBeDefined();
    click(button("Done")!);
    expect(button("Create alert")).toBeDefined();
  });

  // Mutation: dropping onClear from the condition input keeps the stale threshold.
  it("clearing a committed custom threshold after Customize blocks review and Create", async () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] });
    await settle();
    pick("condition", "Custom");
    const field = () => fieldset("condition").querySelector<HTMLInputElement>("input")!;
    const setValue = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          field(),
          value
        );
        field().dispatchEvent(new Event("input", { bubbles: true }));
      });
    setValue("137");
    act(() => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(latest!.answers.condition).toBe("137");
    click(button("Done")!);
    keepReview = true;
    expect(latest!.isReview).toBe(true);
    click(button("Customize")!);
    setValue("");
    act(() => field().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(latest!.answers.condition).toBeUndefined();
    button("Done")?.click();
    await settle();
    expect(latest!.isReview).toBe(false);
    expect(button("Create alert")).toBeUndefined();
  });
});

describe("manual mode regressions", () => {
  const button = (label: string) =>
    Array.from(
      document.querySelector('[data-testid="manual-form"]')!.querySelectorAll("button")
    ).find((b) => b.textContent === label);
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    keepReview = false;
  });

  // Mutation: dropping onClear from the expiry input keeps the stale expiry.
  it("editing a committed expiry to a past date clears it and blocks Create", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T10:00:00Z") });
    try {
      mount(true, { ...BASE, expiry: "30h", notifiers: ["chat"] });
      await settle();
      const spin = (index: number) =>
        fieldset("expiry").querySelectorAll<HTMLElement>('[role="spinbutton"]')[index]!;
      const arrow = (index: number, key: string) =>
        act(() => {
          spin(index).focus();
          spin(index).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        });
      arrow(3, "ArrowUp");
      expect(latest!.answers.expiry).toBe("2026-10-08T17:00:00.000Z");
      click(button("Done")!);
      keepReview = true;
      expect(latest!.isReview).toBe(true);
      click(button("Customize")!);
      arrow(1, "ArrowDown");
      expect(latest!.answers.expiry).toBe("2026-10-08T17:00:00.000Z");
      expect(spin(1)).toBeDefined();
      expect(spin(2)).toBeDefined();
      act(() => spin(2).dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
      expect(latest!.answers.expiry).toBeUndefined();
      expect(fieldset("expiry").querySelectorAll('[role="spinbutton"]').length).toBeGreaterThan(0);
      expect(fieldset("expiry").textContent).toContain("Must be in the future");
      button("Done")?.click();
      await settle();
      expect(button("Create alert")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  const typeSearch = (select: HTMLElement, text: string) => {
    open(select);
    const search = popover(select)!.querySelector<HTMLInputElement>("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return search;
  };
  const pressEnter = (el: HTMLElement) =>
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  const mockSearch = () =>
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const href = String(url);
      if (/\/queues\?/.test(href) && href.includes("query=")) {
        return new Response(JSON.stringify({ queues: [{ name: "zeta-queue", type: "custom" }] }));
      }
      return new Response(JSON.stringify(ENTITIES.queues));
    });
  const restoreFetch = () =>
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const kind = String(url).match(/\/(queues|tasks|error-groups)(\?|$)/)?.[1];
      return new Response(JSON.stringify(kind ? ENTITIES[kind] : {}));
    });

  // Mutation: filter={() => true} lets Enter pick the static "All queues" chip.
  it("Enter while a search is pending leaves the scope unchanged", async () => {
    mockSearch();
    try {
      mount(true, { area: "queues", what: "queue.depth", condition: "100" });
      await settle();
      const before = { scope: latest!.answers.scope, scopeValue: latest!.answers.scopeValue };
      const search = typeSearch(combobox("scope")!, "zeta");
      pressEnter(search);
      expect({ scope: latest!.answers.scope, scopeValue: latest!.answers.scopeValue }).toEqual(
        before
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
    } finally {
      restoreFetch();
    }
  });

  // Mutation: dropping onSearchChange from the scope select never reloads queues.
  it("searching queues fetches matches beyond the first page and Enter selects one", async () => {
    mockSearch();
    try {
      mount(true, { area: "queues", what: "queue.depth", condition: "100" });
      await settle();
      const select = combobox("scope")!;
      const search = typeSearch(select, "zeta");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      expect(options(select).map((o) => o.textContent)).toEqual(["zeta-queue"]);
      pressEnter(search);
      expect(latest!.answers).toMatchObject({ scope: "queue", scopeValue: "zeta-queue" });
    } finally {
      restoreFetch();
    }
  });
});

describe("manual mode dropdowns", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Mutation: restoring the Custom option for scope fails this.
  it("renders selects and offers no Custom scope for a plain draft", () => {
    mount(true, { area: "queues", what: "queue.depth", condition: "100" });
    expect(combobox("what")).not.toBeNull();
    expect(fieldset("what").querySelector("li button[aria-pressed]")).toBeNull();
    expect(allOptionLabels(combobox("scope")!)).toEqual(["All queues"]);
    expect(fieldset("scope").querySelector("input")).toBeNull();
  });

  it("shows the placeholder for an unanswered step", () => {
    mount(true, { area: "queues" });
    expect(combobox("what")!.textContent).toContain("Select…");
  });

  it("condition select shows plain placeholder when empty", () => {
    mount(true, { area: "queues", what: "queue.depth" });
    expect(combobox("condition")!.textContent).toContain("Select…");
  });

  it("keeps the chosen option label while the queue dropdown is open", () => {
    mount(true, { area: "queues", what: "queue.depth", condition: "100", scope: "queue" });
    expect(combobox("scope")!.textContent).toContain("Loading");
    expect(fieldset("scope").querySelectorAll("button[role=combobox]")).toHaveLength(1);
  });

  // Mutation: restoring the notifiers dropdown fails this.
  it("renders notifiers as a one-column checkbox list and ticking updates answers", () => {
    mount(true, { ...BASE, expiry: "none" });
    expect(combobox("notifiers")).toBeNull();
    expect(fieldset("notifiers").querySelector("button[aria-pressed]")).toBeNull();
    const list = fieldset("notifiers").querySelector("[data-checkbox-list]")!;
    expect(list.className).toContain("flex-col");
    expect(checkboxLabels("notifiers")).toEqual(["This chat", "Ops webhook", "Email to ops"]);
    tick("notifiers", ["Ops webhook", "Email to ops"]);
    expect(latest!.answers.notifiers).toEqual(["ch_1", "ch_2"]);
    expect(checkedLabels("notifiers")).toEqual(["Ops webhook", "Email to ops"]);
  });

  it("unticking a selected notifier removes it", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat", "ch_1"] });
    tick("notifiers", ["Ops webhook"]);
    expect(latest!.answers.notifiers).toEqual(["chat"]);
  });

  it("Add channel is a button and is not stored as a notifier", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] }, {
      projectId: "p1",
      canWrite: true,
      atLimit: false,
    } as never);
    click(
      Array.from(fieldset("notifiers").querySelectorAll("button")).find(
        (b) => b.textContent === "Add channel"
      )!
    );
    expect(latest!.answers.notifiers).toEqual(["chat"]);
  });

  it("Add channel sits below the list with a plus icon and no ellipsis", () => {
    mount(true, { ...BASE, expiry: "none", notifiers: ["chat"] }, {
      projectId: "p1",
      canWrite: true,
      atLimit: false,
    } as never);
    const list = fieldset("notifiers").querySelector("[data-checkbox-list]")!;
    expect(list.className).toContain("mt-1");
    const add = Array.from(fieldset("notifiers").querySelectorAll("button")).find(
      (b) => b.textContent === "Add channel"
    )!;
    expect(list.contains(add)).toBe(false);
    expect(add.className).toContain("mt-3");
    expect(add.className).toContain("group/button");
    expect(add.querySelector("svg")!.innerHTML).toContain("M10.75 4.75");
    expect(add.textContent).not.toContain("…");
  });

  it("aligns the unit suffix with the input below the label", () => {
    mount(true, { area: "health", what: "health.flow" });
    const unit = Array.from(fieldset("condition").querySelectorAll("span")).find(
      (el) => el.textContent === "ms"
    )!;
    expect(unit.className).toContain("mt-6");
  });

  // Mutation: giving one unit box a different width class fails this.
  it("health unit boxes share one fixed width and every input is the same width", () => {
    mount(true, { area: "health", what: "health.flow" });
    const units = Array.from(fieldset("condition").querySelectorAll("li > span")).filter((el) =>
      ["ms", "runs", "%"].includes(el.textContent ?? "")
    );
    expect(units.length).toBeGreaterThan(1);
    const widths = units.map((el) =>
      el.className
        .split(" ")
        .filter((c) => /^w-/.test(c))
        .join(" ")
    );
    expect(widths[0]).toBeTruthy();
    expect(new Set(widths).size).toBe(1);
    const inputs = fieldset("condition").querySelectorAll("input");
    const cols = new Set(
      Array.from(inputs).map((i) => i.closest("[class*='max-w-[372px]']")!.className)
    );
    expect(cols.size).toBe(1);
  });

  // Mutation: hiding the dropdown when Custom is selected or removing the input below fails this.
  it("Custom in condition keeps the dropdown showing 'Custom' and renders the 1000 input below", () => {
    mount(true, { area: "queues", what: "queue.depth" });
    pick("condition", "Custom");
    expect(combobox("condition")).not.toBeNull();
    expect(combobox("condition")!.textContent).toContain("Custom");
    const input = fieldset("condition").querySelector<HTMLInputElement>("input")!;
    expect(input.placeholder).toBe("1000");
    expect(document.activeElement).toBe(input);
    pick("condition", "50");
    expect(fieldset("condition").querySelector("input")).toBeNull();
  });

  it("shows step descriptions and drops the trailing above from health labels", () => {
    mount(true, { area: "health", what: "health.flow" });
    const text = fieldset("condition").textContent!;
    expect(text).toContain("Fires when any of these values goes above its threshold.");
    expect(text).not.toMatch(/above(?! its)/);
    const input = fieldset("condition").querySelector("input")!;
    expect(input.closest("[class*='max-w-[372px]']")).not.toBeNull();
    expect(fieldset("condition").querySelector(".grid-cols-2")).toBeNull();
    expect(text).toContain("ms");
  });

  it("changing an earlier answer collapses later steps and Done is only on notifiers", () => {
    const steps = () =>
      Array.from(document.querySelectorAll("fieldset[data-step]")).map((f) =>
        f.getAttribute("data-step")
      );
    const done = () =>
      Array.from(document.querySelectorAll("button")).filter((b) => b.textContent === "Done");
    mount(true, { ...BASE, expiry: "none" });
    expect(steps()).toContain("notifiers");
    expect(done().length).toBe(1);
    expect(fieldset("notifiers").contains(done()[0]!)).toBe(true);
    pick("area", "Runs");
    expect(steps()).not.toContain("notifiers");
    expect(done().length).toBe(0);
  });

  // Mutation: rendering every step (not just up to the current one) fails this.
  it("shows only answered steps plus the next one", () => {
    const steps = () =>
      Array.from(document.querySelectorAll("fieldset[data-step]")).map((f) =>
        f.getAttribute("data-step")
      );
    mount(true);
    expect(steps()).toEqual(["area"]);
    pick("area", "Queues");
    expect(steps()).toEqual(["area", "what"]);
  });

  // Mutation: restoring the border/divide-y wrapper or the full-width triggers fails this.
  it("has no bordered container and 176px triggers", () => {
    mount(true, { ...BASE, expiry: "none" });
    const form = document.querySelector('[data-testid="manual-form"]')!;
    expect(form.querySelector("[class*='border-grid-bright']")).toBeNull();
    expect(form.querySelector(".divide-y")).toBeNull();
    const triggers = Array.from(form.querySelectorAll("button[role=combobox]"));
    expect(triggers.length).toBeGreaterThan(1);
    for (const trigger of triggers)
      expect(trigger.className).toMatch(/w-\[176px\]|max-w-\[372px\]/);
  });

  it("skips a single-option scope step", () => {
    mount(true, { area: "health", what: "health.liveness" });
    expect(fieldset("scope")).toBeNull();
    expect(latest!.answers.scope).toBe("all");
  });

  it("loads error groups and picks one as the errorGroup scope", () => {
    fetcherState.data = undefined;
    fetcherState.loads = [];
    mount(true, { area: "errors", what: "errors.occurred_again" });
    expect(fetcherState.loads[0]).toContain("/alerts/error-groups");
    expect(combobox("scope")!.textContent).toContain("Loading…");

    fetcherState.data = {
      groups: [
        { fingerprint: "fp1", taskIdentifier: "my-task", label: "my-task · Error: boom" },
        { fingerprint: "fp2", taskIdentifier: "other", label: "other · TypeError: nope" },
      ],
    };
    remount();
    mount(true, { area: "errors", what: "errors.occurred_again" });
    const select = combobox("scope")!;
    open(select);
    expect(options(select).map((o) => o.textContent)).toEqual([
      "my-task · Error: boom",
      "other · TypeError: nope",
      "Enter an error id…",
    ]);
    click(options(select)[1]!);
    expect(parseErrorGroupScope(latest!.answers.scopeValue)).toEqual({
      type: "errorGroup",
      taskIdentifier: "other",
      fingerprint: "fp2",
    });
    expect(latest!.answers.scope).toBe("errorGroup");

    expect(combobox("scope")!.textContent).toContain("other · TypeError: nope");
    open(combobox("scope")!);
    click(options(combobox("scope")!)[0]!);
    expect(parseErrorGroupScope(latest!.answers.scopeValue)?.fingerprint).toBe("fp1");
    expect(combobox("scope")!.textContent).toContain("my-task · Error: boom");
  });

  it("refetches and shows loading again when the environment changes", () => {
    fetcherState.data = undefined;
    fetcherState.loads = [];
    fetcherState.env = "dev";
    mount(true, { area: "errors", what: "errors.occurred_again" });
    fetcherState.data = {
      groups: [{ fingerprint: "fp1", taskIdentifier: "t", label: "t · E: x" }],
    };
    mount(true, { area: "errors", what: "errors.occurred_again" });
    expect(combobox("scope")!.textContent).not.toContain("Loading…");
    fetcherState.data = undefined;
    fetcherState.env = "prod";
    mount(true, { area: "errors", what: "errors.occurred_again" });
    expect(fetcherState.loads[fetcherState.loads.length - 1]).toContain("/env/prod/");
    expect(combobox("scope")!.textContent).toContain("Loading…");
    fetcherState.env = "dev";
  });

  it("offers only the error id entry when there are no error groups", () => {
    fetcherState.data = { groups: [] };
    mount(true, { area: "errors", what: "errors.occurred_again" });
    const select = combobox("scope")!;
    expect(select.textContent).toContain("No error groups in the last 7 days");
    open(select);
    expect(options(select).map((o) => o.textContent)).toEqual(["Enter an error id…"]);
    click(options(select)[0]!);
    expect(fieldset("scope").querySelector('input[aria-label="Error id"]')).not.toBeNull();
  });

  // Mutation: dropping onClear from paramInput keeps the stale parameter.
  it("clearing a committed health param after Customize blocks review and Create", async () => {
    mount(true, {
      area: "health",
      what: "health.flow",
      scope: "all",
      expiry: "none",
      notifiers: ["chat"],
    });
    await settle();
    const button = (label: string) =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent === label
      );
    const input = (label: string) =>
      fieldset("condition").querySelector<HTMLInputElement>(
        `input[aria-label="${label} threshold"]`
      )!;
    const type = (el: HTMLInputElement, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type(input("Scheduling delay p95"), "40000");
    type(input("Queued runs"), "500");
    click(button("Done")!);
    keepReview = true;
    expect(latest!.isReview).toBe(true);
    click(button("Customize")!);
    type(input("Queued runs"), "");
    act(() => input("Queued runs").dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(latest!.answers.conditionParams).toEqual({ schedulingDelayMs: 40000 });
    button("Done")?.click();
    await settle();
    expect(latest!.isReview).toBe(false);
    expect(button("Create alert")).toBeUndefined();
  });

  // Mutation: dropping the single-param onClear keeps the stale value instead of the default.
  it("clearing a committed single health param drops it so the default applies", async () => {
    mount(true, {
      area: "health",
      what: "health.liveness",
      scope: "all",
      conditionParams: { silenceSec: 600 },
      expiry: "none",
      notifiers: ["chat"],
    });
    await settle();
    pick("condition", "Custom");
    const field = fieldset("condition").querySelector<HTMLInputElement>("input")!;
    expect(field.value).toBe("600");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(latest!.answers.conditionParams?.silenceSec).toBeUndefined();
  });

  // Mutation: removing the conditionFilled confirm keeps the later steps disabled.
  it("filling both health params reveals the next step without Continue", () => {
    mount(true, { area: "health", what: "health.flow", scope: "all" });
    const revealed = () => Boolean(fieldset("expiry") && !fieldset("expiry").disabled);
    expect(revealed()).toBe(false);
    const input = (label: string) =>
      fieldset("condition").querySelector<HTMLInputElement>(
        `input[aria-label="${label} threshold"]`
      )!;
    const type = (el: HTMLInputElement, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    type(input("Scheduling delay p95"), "40000");
    expect(revealed()).toBe(false);
    type(input("Queued runs"), "500");
    expect(revealed()).toBe(true);
    expect(latest!.answers.conditionParams).toEqual({
      schedulingDelayMs: 40000,
      backlogCount: 500,
    });
  });
});

describe("areas with nothing to watch", () => {
  const groups = ENTITIES["error-groups"];
  const queues = ENTITIES.queues;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetcherState.routed = true;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    fetcherState.routed = false;
    ENTITIES["error-groups"] = groups;
    ENTITIES.queues = queues;
  });

  const cardAreas = () => rowLabels(document.querySelector("[role=dialog]")!);

  // Mutation: hiding the whole Errors area again fails this.
  it("with no error groups keeps Errors but offers only new-error alerts", async () => {
    ENTITIES["error-groups"] = { groups: [] };
    mount(false);
    await settle();
    expect(cardAreas()).toEqual(["Queues", "Runs", "Health", "Errors", "Show me what I can watch"]);
    click(
      Array.from(document.querySelectorAll<HTMLButtonElement>("[role=dialog] li button")).find(
        (b) => b.textContent === "Errors"
      )!
    );
    const what = rowLabels(document.querySelector("[role=dialog]")!);
    expect(what).toContain("A new error appearing");
    expect(what).not.toContain("This error occurring again");
    remount();
    mount(true);
    await settle();
    pick("area", "Errors");
    expect(combobox("what")).toBeNull();
    expect(latest!.answers.what).toBe("errors.new");
  });

  // Mutation: removing the auto-select effect in ManualStep fails this.
  it("a step with one option renders no dropdown and answers it", async () => {
    ENTITIES["error-groups"] = { groups: [] };
    mount(true);
    await settle();
    pick("area", "Errors");
    expect(combobox("what")).toBeNull();
    expect(fieldset("what").textContent).toContain("What about errors?");
    expect(latest!.answers.what).toBe("errors.new");
  });

  // Mutation: dropping the emptyAreas filter in allSteps fails this.
  it("hides Queues when the environment has no queues", async () => {
    ENTITIES.queues = { queues: [], hasMore: false };
    mount(true);
    await settle();
    expect(optionLabels("area")).toEqual(["Runs", "Health", "Errors"]);
  });

  it("shows all four areas when every list has entries", async () => {
    mount(true);
    await settle();
    // Mutation: keeping the show-me option in the manual form fails this.
    expect(optionLabels("area")).toEqual(["Queues", "Runs", "Health", "Errors"]);
  });

  it("a draft prefilled with errors keeps Errors answered when the list is empty", async () => {
    ENTITIES["error-groups"] = { groups: [] };
    mount(true, { area: "errors", what: "errors.new" });
    await settle();
    expect(chosen("area")).toContain("Errors");
    expect(latest!.answers.area).toBe("errors");
    expect(fieldset("what")).not.toBeNull();
  });
});

// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
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
  areaChips,
  type FlowAnswers,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { CreationTranscript } from "./CreationTranscript";
import { createAlertRequestBody } from "./createAlertRequest";

vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => ({ slug: "org" }) }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => ({ slug: "proj" }) }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => ({ slug: "dev" }) }));

globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}))) as typeof fetch;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const IDS = { organizationId: "o", projectId: "p", environmentId: "e" };

let container: HTMLElement;
let root: Root;
let latest: CreationFlowState | undefined;

function Harness({ initial, queueMetrics }: { initial?: FlowAnswers; queueMetrics: boolean }) {
  const flow = useCreationFlowState(vi.fn(), initial);
  // eslint-disable-next-line -- test harness captures the hook return
  latest = flow;
  return createElement(CreationTranscript, {
    flow,
    channels: [],
    chatId: "chat_1",
    queueMetricsEnabled: queueMetrics,
  });
}

function mount(initial?: FlowAnswers, queueMetrics = true) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(ShortcutsProvider, null, createElement(Harness, { initial, queueMetrics }))
      )
    )
  );
}

const card = () => document.querySelector<HTMLElement>("[role=dialog]")!;
const buttons = () => Array.from(card().querySelectorAll("button"));

function pick(label: string) {
  const btn = buttons().find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`Card option "${label}" not found`);
  act(() => btn.click());
}

const percentInput = () =>
  card().querySelector<HTMLInputElement>('input[aria-label="Utilisation threshold"]')!;
const inputChecked = () =>
  percentInput().closest("li")!.querySelector('[aria-label="Selected"]') !== null;
const labelChecked = () =>
  buttons()
    .find((b) => b.textContent?.trim() === "Approaching the limit")!
    .querySelector('[aria-label="Selected"]') !== null;

const pressed = (label: string) =>
  buttons()
    .find((b) => b.textContent?.trim() === label)
    ?.getAttribute("aria-pressed");

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const body = () =>
  createAlertRequestBody(IDS, { ...latest!.answers, scope: "all", notifiers: ["ch_1"] }).form;

describe("Limits wizard", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("describes the area with the framing sentence", () => {
    mount();
    expect(areaChips().find((c) => c.value === "limits")?.description).toContain(
      "limits that can interrupt or degrade runtime flow"
    );
    expect(card().querySelector('button[aria-label="About Limits"]')).not.toBeNull();
  });

  // Mutation: dropping `group` from the chips renders no headers.
  it("groups the what step under Platform and Webhooks", () => {
    mount({ area: "limits" });
    const items = Array.from(card().querySelectorAll("ul > li"));
    const layout: Record<string, string[]> = {};
    let group = "";
    for (const li of items) {
      if (li.hasAttribute("data-group-header")) {
        group = li.textContent!.trim();
        layout[group] = [];
      } else if (group) {
        const text = li.querySelector(":scope > button")?.textContent?.trim();
        if (text) layout[group]!.push(text);
      }
    }
    expect(Object.keys(layout)).toEqual(["Platform", "Webhooks"]);
    expect(layout.Platform).toEqual([
      "API rate limit running out",
      "Environment concurrency filling up",
      "Queue size nearing its limit",
    ]);
    expect(layout.Webhooks.slice(0, 4)).toEqual([
      "Webhook processing saturating",
      "Webhook ingress getting rate-limited",
      "Webhook endpoint getting rate-limited",
      "Webhook waiters running out",
    ]);
    expect(card().textContent).toContain("Pick any number");
    expect(card().textContent).toContain("Watch all limits");
  });

  it("leaves the health what step as it was", () => {
    mount({ area: "health" });
    const rows = Array.from(card().querySelectorAll("li > button")).map((b) => b.textContent);
    expect(rows).toEqual([
      "Flow health degrading",
      "Execution health degrading",
      "Tasks going silent",
      "Overall health check",
      "Show me what I can watch",
    ]);
    expect(card().querySelector("[data-group-header]")).toBeNull();
    expect(card().textContent).not.toContain("Pick any number");
  });

  // Mutation: not hiding the queue-metric caps leaves them listed.
  it("hides queue-metric limits when queue metrics are off", () => {
    mount({ area: "limits" }, false);
    const text = card().textContent!;
    expect(text).not.toContain("Environment concurrency filling up");
    expect(text).not.toContain("Queue size nearing its limit");
    expect(text).toContain("API rate limit running out");
  });

  // Mutation: omitting components or compositeMode from the request fails this.
  it("two or more picks make a limits.all composite with exactly those components", () => {
    mount({ area: "limits" });
    pick("Webhook waiters running out");
    pick("API rate limit running out");
    pick("Continue");
    expect(card().getAttribute("aria-label")).toBe("When should this alert fire?");
    expect(pressed("Raise when any")).toBe("true");
    pick("Raise when all");
    expect(pressed("Raise when all")).toBe("true");
    expect(inputChecked()).toBe(false);
    const form = body();
    expect(form.capabilityKey).toBe("limits.all");
    expect(form.components).toEqual(["limits.api", "limits.webhooks.waiters"]);
    expect(form.compositeMode).toBe("all");
    expect(form.signals).toEqual(["limited"]);
    expect(form.conditionParams).toBeUndefined();
  });

  it("a single pick stays a standalone alert", () => {
    mount({ area: "limits" });
    pick("Webhook waiters running out");
    pick("Continue");
    const form = body();
    expect(form.capabilityKey).toBe("limits.webhooks.waiters");
    expect(form.components).toBeUndefined();
    expect(form.compositeMode).toBeUndefined();
  });

  // Mutation: dropping useDefaultComponents leaves components undefined.
  it.each([
    [true, 7],
    [false, 5],
  ])("a preselected limits.all defaults components (queue metrics %s)", (metrics, count) => {
    mount({ area: "limits", what: "limits.all" }, metrics);
    expect(body().components).toHaveLength(count);
  });

  // Mutation: confirming against the unfiltered list saves the hidden queue limits.
  it.each([
    [true, 7],
    [false, 5],
  ])("Watch all limits saves every offered limit (queue metrics %s)", (metrics, count) => {
    mount({ area: "limits" }, metrics);
    pick("Watch all limits");
    pick("Continue");
    const form = body();
    expect(form.capabilityKey).toBe("limits.all");
    expect(form.components).toHaveLength(count);
    expect(form.compositeMode).toBe("any");
  });

  // Mutation: omitting signals or utilisationPct from the request fails this.
  it("limited is implicit and a percentage adds approaching", () => {
    mount({ area: "limits" });
    pick("API rate limit running out");
    pick("Continue");
    expect(card().getAttribute("aria-label")).toBe("When should this alert fire?");
    expect(card().textContent).toContain("Fires when the limit is hit");
    expect(buttons().some((b) => b.textContent?.trim() === "Limit reached")).toBe(false);
    const input = () =>
      card().querySelector<HTMLInputElement>('input[aria-label="Utilisation threshold"]')!;
    expect(input().value).toBe("");
    expect(input().placeholder).toBe("80");
    expect(buttons().find((b) => b.textContent?.trim() === "Continue")!.disabled).toBe(false);
    expect(inputChecked()).toBe(false);
    expect(labelChecked()).toBe(false);
    let form = body();
    expect(form.signals).toEqual(["limited"]);
    expect(form.conditionParams).toBeUndefined();
    type(input(), "70");
    expect(inputChecked()).toBe(true);
    expect(labelChecked()).toBe(false);
    form = body();
    expect(form.signals).toEqual(["limited", "approaching"]);
    expect(form.conditionParams).toEqual({ utilisationPct: 70 });
    expect(form.components).toBeUndefined();
    type(input(), "");
    expect(inputChecked()).toBe(false);
  });

  // Mutation: leaving explicit signals untouched on a percentage edit fails both rows.
  it.each([
    ["entering a percentage adds approaching", ["limited"], ["70"], ["approaching", "limited"], 70],
    [
      "clearing it drops approaching",
      ["limited", "approaching"],
      ["90", ""],
      ["limited"],
      undefined,
    ],
  ] as const)("agent-set signals: %s", (_, signals, typed, expected, expectedPct) => {
    mount({ area: "limits" });
    pick("API rate limit running out");
    pick("Continue");
    act(() => latest!.updateAnswers({ signals: [...signals] }));
    for (const value of typed) type(percentInput(), value);
    expect(body().signals).toEqual(expected);
    expect(body().conditionParams?.utilisationPct).toBe(expectedPct);
  });

  it("an approaching-only limit always watches approaching", () => {
    mount({ area: "limits" });
    pick("Queue size nearing its limit");
    pick("Continue");
    expect(percentInput().value).toBe("80");
    expect(inputChecked()).toBe(true);
    expect(labelChecked()).toBe(false);
    expect(body().signals).toEqual(["approaching"]);
  });

  it("shows the percentage input directly under Approaching the limit", () => {
    mount({ area: "limits" });
    pick("API rate limit running out");
    pick("Continue");
    const approaching = buttons().find((b) => b.textContent?.trim() === "Approaching the limit")!;
    const input = card().querySelector('input[aria-label="Utilisation threshold"]')!;
    expect(approaching.closest("li")!.nextElementSibling!.contains(input)).toBe(true);
  });
});

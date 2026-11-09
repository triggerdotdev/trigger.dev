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
  capabilityChips,
  isComposite,
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

function Harness({ initial }: { initial?: FlowAnswers }) {
  const flow = useCreationFlowState(vi.fn(), initial);
  // eslint-disable-next-line -- test harness captures the hook return
  latest = flow;
  return createElement(CreationTranscript, {
    flow,
    channels: [],
    chatId: "chat_1",
    queueMetricsEnabled: true,
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

const card = () => document.querySelector<HTMLElement>("[role=dialog]")!;
const buttons = () => Array.from(card().querySelectorAll("button"));

function pick(label: string) {
  const btn = buttons().find((b) => b.textContent?.trim() === label);
  if (!btn) throw new Error(`Card option "${label}" not found`);
  act(() => btn.click());
}

const body = () =>
  createAlertRequestBody(IDS, { ...latest!.answers, scope: "all", notifiers: ["ch_1"] }).form;

describe("Health wizard", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Catches: resolveWhat returning health.all for one pick fails the single case.
  it.each([
    [["Flow health degrading"], "health.flow", undefined],
    [
      ["Flow health degrading", "Tasks going silent"],
      "health.all",
      ["health.flow", "health.liveness"],
    ],
    [
      ["Flow health degrading", "Execution health degrading", "Tasks going silent"],
      "health.all",
      ["health.flow", "health.execution", "health.liveness"],
    ],
  ])("picking %j saves %s", (picks, capabilityKey, components) => {
    mount({ area: "health" });
    expect(card().textContent).toContain("Pick any number");
    for (const label of picks) pick(label);
    pick("Continue");
    const form: { capabilityKey?: string; components?: string[] } = body();
    expect(form.capabilityKey).toBe(capabilityKey);
    expect(form.components).toEqual(components);
  });

  // Catches: a composite row (health.all) listed next to the three health checks.
  it("offers exactly the three checks as rows", () => {
    mount({ area: "health" });
    const labels = capabilityChips("health")
      .filter((chip) => !isComposite(chip.value))
      .map((chip) => chip.label);
    expect(labels).toHaveLength(3);
    const rows = Array.from(card().querySelectorAll("li > button")).map((b) =>
      b.textContent?.trim()
    );
    expect(rows.filter((row) => row !== "Continue" && row !== "Show me what I can watch")).toEqual(
      labels
    );
  });

  // Catches: a health.all draft's compositeMode being dropped from the request.
  it("sends the composite mode of a health.all draft", () => {
    mount({ area: "health", what: "health.all", compositeMode: "all" });
    expect((body() as { compositeMode?: string }).compositeMode).toBe("all");
  });

  // Catches: a threshold sent for a check that was not picked.
  it("sends no threshold for an excluded check", () => {
    mount({
      area: "health",
      what: "health.all",
      components: ["health.execution"],
      conditionParams: { failureRatePct: 20, backlogCount: 5 },
    });
    expect((body() as { conditionParams?: Record<string, number> }).conditionParams).toEqual({
      failureRatePct: 20,
    });
  });

  // Catches: thresholds of unpicked checks listed in the condition step.
  it("only asks for the thresholds of the picked checks", () => {
    mount({ area: "health", what: "health.all", components: ["health.execution"] });
    expect(card().textContent).toContain("Failure rate");
    expect(card().textContent).not.toContain("Scheduling delay");
  });

  // Catches: the silence threshold dropped when liveness is picked with another check.
  it("asks for the silence threshold when liveness is picked with another check", () => {
    mount({ area: "health", what: "health.all", components: ["health.flow", "health.liveness"] });
    expect(card().textContent).toContain("Silence");
    expect(card().textContent).toContain("Queued runs");
  });
});

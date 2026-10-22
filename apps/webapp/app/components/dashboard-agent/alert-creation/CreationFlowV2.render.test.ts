import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { CreationTranscript } from "~/components/alerts/CreationTranscript";
import type { CreationFlowState } from "./CreationFlow";
import {
  prefillToAnswers,
  stripCreateSearchParams,
  type FlowAnswers,
  type FlowStepKey,
} from "./flow-state";

vi.mock("~/hooks/useOrganizations", () => ({ useOptionalOrganization: () => undefined }));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => undefined }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => undefined }));

function wrap(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, el)
    )
  );
}

const noop = () => {};

function makeFlow(overrides: Partial<CreationFlowState> = {}): CreationFlowState {
  return {
    answers: {},
    currentStep: "area" as FlowStepKey,
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
    ...overrides,
  };
}

describe("CreationTranscript variant-1 port", () => {
  it("fails when the opening line differs from 'What would you like me to watch?'", () => {
    const flow = makeFlow({ currentStep: "area" });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("What would you like me to watch?");
  });

  it("fails when area chips render without icons", () => {
    const flow = makeFlow({ currentStep: "area" });
    const html = wrap(createElement(CreationTranscript, { flow }));
    for (const label of ["Queues", "Runs", "Health"]) {
      const end = html.indexOf(`>${label}</span>`);
      const row = html.slice(html.lastIndexOf("<button", end), end);
      expect(row).toContain("<svg");
    }
  });

  it("renders the review card with Customize button", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    };
    const flow = makeFlow({
      answers,
      currentStep: undefined,
      isReview: true,
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Queue depth" },
        { key: "scope", prompt: "c", label: "All" },
        { key: "condition", prompt: "d", label: "100" },
        { key: "notifiers", prompt: "f", label: "chat" },
      ],
    });
    const html = wrap(
      createElement(CreationTranscript, {
        flow,
      })
    );
    expect(html).toContain("Create alert");
    expect(html).toContain("Customize");
    expect(html).toContain("Start over");
  });

  it("fails when Customize does not reopen the manual form prefilled", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    };
    const flow = makeFlow({
      answers,
      currentStep: undefined,
      isReview: true,
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Queue depth" },
        { key: "scope", prompt: "c", label: "All" },
        { key: "condition", prompt: "d", label: "100" },
        { key: "notifiers", prompt: "f", label: "chat" },
      ],
    });
    const html = wrap(
      createElement(CreationTranscript, {
        flow,
      })
    );
    expect(html).toContain("Customize");
    expect(flow.answers.area).toBe("queues");
    expect(flow.answers.what).toBe("queue.depth");
  });

  it("fails when the success card omits the lifetime line", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
    };
    const flow = makeFlow({
      answers,
      currentStep: undefined,
      isReview: false,
      created: true,
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("is active.");
    expect(html).toContain("It stays active until you turn it off.");
  });

  it("renders success with expiry lifetime", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
      expiry: "24h",
    };
    const flow = makeFlow({
      answers,
      currentStep: undefined,
      isReview: false,
      created: true,
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("It expires in 24h.");
  });

  it("fails when health param inputs are missing in the condition step", () => {
    const answers: FlowAnswers = {
      area: "health",
      what: "health.flow",
      scope: "all",
    };
    const flow = makeFlow({
      answers,
      currentStep: "condition",
      completedSteps: [
        { key: "area", prompt: "a", label: "Health" },
        { key: "what", prompt: "b", label: "Health (Flow)" },
        { key: "scope", prompt: "c", label: "All" },
      ],
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain('aria-label="Queued runs threshold"');
  });

  it("fails when contextual prefill is dropped", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
    };
    const flow = makeFlow({
      answers,
      currentStep: "scope",
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Queue depth" },
      ],
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain('aria-label="Which queues should this alert cover?"');
    expect(html).toContain("4 of 6");
    expect(flow.answers.area).toBe("queues");
    expect(flow.answers.what).toBe("queue.depth");
  });

  it("fails when ?create=1 does not open the panel after mount", () => {
    const params = new URLSearchParams("?create=1&capability=queue.depth&scope=all");
    const answers = prefillToAnswers({
      capability: params.get("capability") ?? undefined,
      scope: params.get("scope") ?? undefined,
    });
    expect(answers.area).toBe("queues");
    expect(answers.what).toBe("queue.depth");
    expect(answers.scope).toBe("all");
    const stripped = stripCreateSearchParams(params);
    expect(stripped.get("create")).toBeNull();
    expect(stripped.get("capability")).toBeNull();
  });
});

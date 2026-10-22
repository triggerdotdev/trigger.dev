import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { CreationTranscript } from "./CreationTranscript";
import { CreationChatShell } from "./CreationChatShell";
import type { CreationFlowState } from "~/components/dashboard-agent/alert-creation/CreationFlow";
import {
  capabilityPhrase,
  type FlowStepKey,
} from "~/components/dashboard-agent/alert-creation/flow-state";
import { listCapabilities } from "@internal/alert-contracts";

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

describe("D1–D8 prototype parity", () => {
  it("fails when the shell is not floating with title 'New alert'", () => {
    const flow = makeFlow({ currentStep: "area" });
    const html = wrap(
      createElement(
        CreationChatShell,
        { placement: "docked", title: "New alert" },
        createElement(CreationTranscript, { flow })
      )
    );
    expect(html).toContain('data-placement="docked"');
    expect(html).toContain('data-title="New alert"');
  });

  it("fails when the opening bubble text differs", () => {
    const flow = makeFlow({ currentStep: "area" });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("Create a new alert");
    expect(html).toContain("What would you like me to watch?");
    expect(html).toContain("Show me what I can watch");
  });

  it("fails when a capability renders its raw key/enum label", () => {
    const allCaps = listCapabilities({ surface: "agent" });
    for (const cap of allCaps) {
      const phrase = capabilityPhrase(cap.key);
      expect(phrase).not.toBe(cap.key);
      expect(phrase).not.toBe(cap.title);
    }

    const flow = makeFlow({
      answers: { area: "queues" },
      currentStep: "what",
      completedSteps: [{ key: "area", prompt: "a", label: "Queues" }],
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).not.toContain("Queue depth");
    expect(html).not.toContain("queue.depth");
    expect(html).toContain("Depth getting too high");
  });

  it("fails when the condition step renders an <input> instead of suggestion chips (custom chip excluded)", () => {
    const flow = makeFlow({
      answers: { area: "queues", what: "queue.depth", scope: "all" },
      currentStep: "condition",
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Depth getting too high" },
        { key: "scope", prompt: "c", label: "All queues" },
      ],
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("50");
    expect(html).toContain("100");
    expect(html).toContain("200");
    expect(html).not.toContain("Something else");
    expect(html).toContain("Custom");
    expect(html).not.toContain("<input");
  });

  it("fails when Done at notifiers does not trigger create", () => {
    const flow = makeFlow({
      answers: {
        area: "queues",
        what: "queue.depth",
        scope: "all",
        condition: "100",
        expiry: "none",
        notifiers: ["chat"],
      },
      currentStep: "notifiers",
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Depth getting too high" },
        { key: "scope", prompt: "c", label: "All queues" },
        { key: "condition", prompt: "d", label: "100" },
      ],
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("Done");
    expect(html).not.toContain(">Continue<");
  });

  it("fails when Done with no notifiers triggers create", () => {
    const flow = makeFlow({
      answers: {
        area: "queues",
        what: "queue.depth",
        scope: "all",
        condition: "100",
        expiry: "none",
      },
      currentStep: "notifiers",
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Depth getting too high" },
        { key: "scope", prompt: "c", label: "All queues" },
        { key: "condition", prompt: "d", label: "100" },
      ],
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("Pick at least one destination");
    expect(html).toContain('role="alert"');
  });

  it("fails when the created title does not switch to 'Alert created'", () => {
    const notCreatedTitle = "New alert";
    const createdTitle = "Alert created";
    const flow = makeFlow({
      answers: {
        area: "queues",
        what: "queue.depth",
        scope: "all",
        condition: "100",
        notifiers: ["chat"],
      },
      currentStep: undefined,
      created: true,
    });
    const htmlCreated = wrap(
      createElement(
        CreationChatShell,
        { placement: "docked", title: createdTitle },
        createElement(CreationTranscript, { flow })
      )
    );
    expect(htmlCreated).toContain('data-title="Alert created"');

    const flowActive = makeFlow({ currentStep: "area" });
    const htmlActive = wrap(
      createElement(
        CreationChatShell,
        { placement: "docked", title: notCreatedTitle },
        createElement(CreationTranscript, { flow: flowActive })
      )
    );
    expect(htmlActive).toContain('data-title="New alert"');
    expect(htmlActive).not.toContain('data-title="Alert created"');
  });

  it("fails when scope options lack All and Specific or show a custom input", () => {
    const flow = makeFlow({
      answers: { area: "queues", what: "queue.depth" },
      currentStep: "scope",
      completedSteps: [
        { key: "area", prompt: "a", label: "Queues" },
        { key: "what", prompt: "b", label: "Depth getting too high" },
      ],
    });
    const html = wrap(createElement(CreationTranscript, { flow }));
    expect(html).toContain("All queues");
    expect(html).not.toContain("Specific queue");
    expect(html).toContain("Loading…");
    expect(html).not.toContain("Something else");
    expect(html).not.toContain('placeholder="Custom value..."');
  });
});

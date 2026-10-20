import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { CreationTranscript } from "~/components/alerts/CreationTranscript";
import type { CreationFlowState } from "./CreationFlow";

function flowWithCompletedArea(): CreationFlowState {
  return {
    answers: { area: "queues", what: "queue.depth" },
    currentStep: undefined,
    completedSteps: [
      { key: "area", prompt: "What area?", label: "Queues" },
      { key: "what", prompt: "What metric?", label: "Queue depth" },
    ],
    isReview: false,
    created: false,
    createdAlertId: undefined,
    submitting: false,
    submitError: false,
    selectChip: () => {},
    setCondition: () => {},
    setConditionParams: () => {},
    confirmCondition: () => {},
    setScopeValue: () => {},
    setWindowMinutes: () => {},
    toggleNotifier: () => {},
    confirmNotifiers: () => {},
    setExpiry: () => {},
    create: () => {},
    reset: () => {},
  };
}

function render(flow: CreationFlowState, alertDetailPath?: (id: string) => string) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(CreationTranscript, {
            flow,
            alertDetailPath,
          })
        )
      )
    )
  );
}

describe("completed flow renders no per-step summaries", () => {
  it("fails if frozen step cards return after the flow", () => {
    const html = render(flowWithCompletedArea());
    expect(html).not.toContain("frozen-step-");
    expect(html).not.toContain("What would you like me to watch?");
    expect(html).not.toContain("In Queues I can watch");
  });
});

describe("SuccessCard renders View alert link", () => {
  function createdFlow(alertId: string): CreationFlowState {
    return {
      answers: {
        area: "queues",
        what: "queue.depth",
        scope: "all",
        condition: "100",
        windowMinutes: 5,
        notifiers: ["chat"],
      },
      currentStep: undefined,
      completedSteps: [],
      isReview: false,
      created: true,
      createdAlertId: alertId,
      submitting: false,
      submitError: false,
      selectChip: () => {},
      setCondition: () => {},
      setConditionParams: () => {},
      confirmCondition: () => {},
      setScopeValue: () => {},
      setWindowMinutes: () => {},
      toggleNotifier: () => {},
      confirmNotifiers: () => {},
      setExpiry: () => {},
      create: () => {},
      reset: () => {},
    };
  }

  const ALERT_ID = "alert_test_123";
  const EXPECTED_PATH = `/orgs/org/projects/project/env/dev/alerts/${ALERT_ID}`;

  it("renders a View alert link whose href matches the alertDetailPath", () => {
    const html = render(
      createdFlow(ALERT_ID),
      (id) => `/orgs/org/projects/project/env/dev/alerts/${id}`
    );
    expect(html).toContain(`href="${EXPECTED_PATH}"`);
    expect(html).toContain("View alert");
  });

  it("fails if the View alert link is removed", () => {
    const html = render(
      createdFlow(ALERT_ID),
      (id) => `/orgs/org/projects/project/env/dev/alerts/${id}`
    );
    expect(html).toContain("View alert");
  });
});

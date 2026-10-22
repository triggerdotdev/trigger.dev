// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { allSteps, cardPosition } from "~/components/alerts/wizardSteps";
import { useCreationFlowState, type CreationFlowState } from "./CreationFlow";
import { prefillToAnswers } from "./flow-state";

describe("entry from a queue page", () => {
  // Mutation: dropping the area prefill or the scope carry-over fails this.
  it("opens at the scenario step with the queue scope answered", () => {
    const answers = prefillToAnswers({ area: "queues", scope: "queue", scopeValue: "x" });
    expect(answers).toEqual({ area: "queues", scope: "queue", scopeValue: "x" });
    let latest: CreationFlowState | undefined;
    function Harness() {
      // oxlint-disable-next-line react/globals -- test harness captures the hook return
      latest = useCreationFlowState(vi.fn(), answers);
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(Harness)));
    expect(latest!.currentStep).toBe("what");
    const steps = allSteps(latest!, [], undefined);
    expect(steps.findIndex((step) => step.id === cardPosition(latest!))).toBe(1);
    expect(steps.find((step) => step.id === "what")!.selected).toEqual([]);
    act(() => latest!.selectChip("what", "queue.depth"));
    expect(latest!.answers).toMatchObject({ scope: "queue", scopeValue: "x" });
    expect(latest!.currentStep).toBe("condition");
    act(() => latest!.setCondition("100"));
    expect(latest!.currentStep).toBe("notifiers");
    act(() => root.unmount());
  });
});

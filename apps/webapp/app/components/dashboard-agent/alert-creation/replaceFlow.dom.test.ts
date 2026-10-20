// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyStepSelection,
  cardPosition,
  confirmStep,
  PREVIEW_GROUP,
} from "~/components/alerts/wizardSteps";
import { afterReplace } from "~/components/alerts/legacyAlertChannels";
import { useCreationFlowState, type CreationFlowState } from "./CreationFlow";
import { prefillToAnswers, replacePrefill, type FlowAnswers } from "./flow-state";

let container: HTMLElement | undefined;
let root: Root | undefined;
let latest: CreationFlowState | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const initial: FlowAnswers = prefillToAnswers(
  replacePrefill({ channelId: "ch_1", channelName: "Ops", alertType: "TASK_RUN" }, [
    { id: "prod", type: "PRODUCTION", slug: "prod", branchName: null },
    { id: "pr", type: "PREVIEW", slug: "pr", branchName: "feat" },
  ])
);

const submit = vi.fn();

function Harness() {
  const state = useCreationFlowState(submit, initial);
  useEffect(() => {
    latest = state;
  });
  return null;
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness)));
}

const handlers = { onShowAll: () => {}, onAddChannel: () => {} };

describe("replace flow", () => {
  it("opens on the environments step, then asks expiry and notifiers", () => {
    mount();
    expect(latest!.currentStep).toBe("environments");
    expect(latest!.answers.environments).toEqual(["prod"]);

    act(() => applyStepSelection(latest!, "environments", "pr", handlers));
    expect(latest!.answers.environments).toEqual(["prod", "pr"]);
    expect(latest!.currentStep).toBe("environments");

    act(() => confirmStep(latest!, "environments"));
    expect(cardPosition(latest!)).toBe("expiry");
    act(() => latest!.setExpiry("none"));
    expect(cardPosition(latest!)).toBe("notifiers");
    act(() => latest!.confirmNotifiers());
    expect(latest!.isReview).toBe(true);
  });

  it("keeps the replace context when a step is re-answered", () => {
    mount();
    act(() => latest!.selectChip("scope", "all"));
    expect(latest!.answers.replace?.channelId).toBe("ch_1");
    expect(latest!.answers.environments).toEqual(["prod"]);
  });

  it("submits a preview picked from the expanded group", () => {
    mount();
    act(() => applyStepSelection(latest!, "environments", PREVIEW_GROUP, handlers));
    expect(latest!.answers.previewsExpanded).toBe(true);
    act(() => applyStepSelection(latest!, "environments", "pr", handlers));
    act(() => confirmStep(latest!, "environments"));
    act(() => latest!.setExpiry("none"));
    act(() => latest!.confirmNotifiers());
    act(() => latest!.create());
    expect(submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ environments: ["prod", "pr"], notifiers: ["ch_1"] })
    );
  });
});

describe("after a replace", () => {
  it("navigates to alerts when no legacy alert remains, else revalidates", () => {
    const navigate = vi.fn();
    const revalidate = vi.fn();
    afterReplace(false, "/alerts", navigate, revalidate);
    expect(navigate).toHaveBeenCalledWith("/alerts");
    expect(revalidate).not.toHaveBeenCalled();
    afterReplace(true, "/alerts", navigate, revalidate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});

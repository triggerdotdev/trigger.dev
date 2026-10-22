// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCreationFlowState, type CreationFlowState } from "./CreationFlow";
import { applyDraftPatch } from "./draftPatch";

let container: HTMLElement | undefined;
let root: Root | undefined;
let latest: CreationFlowState | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function Harness() {
  const state = useCreationFlowState(vi.fn());
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

describe("a recommended-values patch from the agent", () => {
  it("opens on the condition step with the params filled", () => {
    mount();
    const params = { failureRatePct: 10, durationP95Ms: 300000 };
    const next = applyDraftPatch({}, { what: "health.execution", condition: { params } });
    act(() => latest!.patchAnswers(next));
    expect(latest!.answers.area).toBe("health");
    expect(latest!.answers.conditionParams).toEqual(params);
    expect(latest!.currentStep).toBe("condition");
  });
});

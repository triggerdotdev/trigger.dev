// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allSteps } from "~/components/alerts/wizardSteps";
import { useCreationFlowState, type CreationFlowState } from "./CreationFlow";
import { lockedScope } from "./flow-state";

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

describe("single-option steps", () => {
  it("auto-answers a lone scope and skips its step", () => {
    expect(lockedScope("health.liveness")).toBe("all");
    expect(lockedScope("queue.depth")).toBeUndefined();
    mount();
    act(() => latest!.selectChip("area", "health"));
    act(() => latest!.selectChip("what", "health.liveness"));
    expect(latest!.answers.scope).toBe("all");
    expect(latest!.currentStep).not.toBe("scope");
    expect(latest!.currentStep).toBe("condition");
  });

  it("keeps the scope step when several scopes are allowed", () => {
    mount();
    act(() => latest!.selectChip("area", "queues"));
    act(() => latest!.selectChip("what", "queue.depth"));
    act(() => latest!.setCondition("100"));
    expect(latest!.answers.scope).toBeUndefined();
    expect(latest!.currentStep).toBe("scope");
  });

  it("drops the scope step from the step list", () => {
    mount();
    act(() => latest!.selectChip("area", "health"));
    act(() => latest!.selectChip("what", "health.liveness"));
    const ids = allSteps(latest!, [], undefined).map((step) => step.id);
    expect(ids).not.toContain("scope");
  });
});

describe("scope auto-answer edge cases", () => {
  it("clears a stale scope value when the capability locks scope", () => {
    mount();
    act(() => latest!.selectChip("area", "queues"));
    act(() => latest!.selectChip("what", "queue.depth"));
    act(() => latest!.selectChip("scope", "queue"));
    act(() => latest!.setScopeValue("q1"));
    expect(latest!.answers.scopeValue).toBe("q1");
    act(() => latest!.selectChip("area", "health"));
    act(() => latest!.selectChip("what", "health.liveness"));
    expect(latest!.answers.scope).toBe("all");
    expect(latest!.answers.scopeValue).toBeUndefined();
  });

  it("auto-answers through patchAnswers and after reset", () => {
    mount();
    act(() => latest!.patchAnswers({ area: "health", what: "health.liveness" }));
    expect(latest!.answers.scope).toBe("all");
    expect(latest!.currentStep).toBe("condition");
    act(() => latest!.reset());
    expect(latest!.answers).toEqual({});
    act(() => latest!.patchAnswers({ area: "health", what: "health.liveness" }));
    expect(latest!.answers.scope).toBe("all");
  });
});

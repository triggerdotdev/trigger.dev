// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useCreationFlowState, type CreationFlowState } from "./CreationFlow";
import type { FlowAnswers } from "./flow-state";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function Harness({
  initialAnswers,
  resetKey,
  onFlow,
}: {
  initialAnswers?: FlowAnswers;
  resetKey?: number;
  onFlow: (flow: CreationFlowState) => void;
}) {
  const flow = useCreationFlowState(undefined, initialAnswers, resetKey);
  useEffect(() => {
    onFlow(flow);
  });
  return null;
}

describe("useCreationFlowState resetKey", () => {
  it("applies new initialAnswers when resetKey changes", () => {
    let flow!: CreationFlowState;
    const capture = (f: CreationFlowState) => {
      flow = f;
    };

    const first: FlowAnswers = { area: "queues", what: "queue.depth", scope: "all" };
    act(() => {
      root.render(createElement(Harness, { initialAnswers: first, resetKey: 0, onFlow: capture }));
    });
    expect(flow.answers.what).toBe("queue.depth");

    act(() => flow.selectChip("scope", "queue"));
    expect(flow.answers.scope).toBe("queue");

    const second: FlowAnswers = {
      area: "errors",
      what: "errors.occurrence_rate",
      scope: "fingerprint",
      scopeValue: "abc123",
    };
    act(() => {
      root.render(createElement(Harness, { initialAnswers: second, resetKey: 1, onFlow: capture }));
    });
    expect(flow.answers.what).toBe("errors.occurrence_rate");
    expect(flow.answers.area).toBe("errors");
    expect(flow.answers.scope).toBe("fingerprint");
  });

  it("does not reset when resetKey stays the same", () => {
    let flow!: CreationFlowState;
    const capture = (f: CreationFlowState) => {
      flow = f;
    };

    const initial: FlowAnswers = { area: "queues", what: "queue.depth" };
    act(() => {
      root.render(
        createElement(Harness, { initialAnswers: initial, resetKey: 0, onFlow: capture })
      );
    });
    act(() => flow.selectChip("scope", "all"));
    expect(flow.answers.scope).toBe("all");

    act(() => {
      root.render(
        createElement(Harness, {
          initialAnswers: { area: "errors", what: "errors.occurrence_rate" },
          resetKey: 0,
          onFlow: capture,
        })
      );
    });
    expect(flow.answers.scope).toBe("all");
    expect(flow.answers.what).toBe("queue.depth");
  });
});

describe("useCreationFlowState stale submission", () => {
  it("does not mark a new draft created when an old submit resolves after resetKey changes", async () => {
    let flow!: CreationFlowState;
    let resolveSubmit!: (v: { alertId: string }) => void;
    const onSubmit = () => new Promise<{ alertId: string }>((r) => (resolveSubmit = r));
    function SubmitHarness({ resetKey }: { resetKey: number }) {
      const f = useCreationFlowState(onSubmit, undefined, resetKey);
      useEffect(() => {
        flow = f;
      });
      return null;
    }
    act(() => root.render(createElement(SubmitHarness, { resetKey: 0 })));
    act(() => flow.selectChip("area", "queues"));
    act(() => flow.selectChip("what", "queue.depth"));
    act(() => flow.selectChip("scope", "all"));
    act(() => flow.setCondition("100"));
    act(() => flow.toggleNotifier("chat"));
    act(() => flow.confirmNotifiers());
    act(() => {
      void flow.create();
    });
    expect(flow.submitting).toBe(true);

    act(() => root.render(createElement(SubmitHarness, { resetKey: 1 })));
    await act(async () => {
      resolveSubmit({ alertId: "alert_old" });
    });
    expect(flow.created).toBe(false);
    expect(flow.createdAlertId).toBeUndefined();
  });
});

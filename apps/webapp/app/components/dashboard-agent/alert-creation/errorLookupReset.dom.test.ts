// @vitest-environment jsdom
import { createElement, useEffect, useState } from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ErrorGroupOption } from "~/components/alerts/errorGroupOptions";
import { useErrorGroupLookup } from "~/components/alerts/useErrorGroupLookup";
import type { CreationFlowState } from "./CreationFlow";
import type { FlowAnswers } from "./flow-state";
import { useCreationAgentSend, type CreationAgentSend } from "./useCreationAgentSend";

describe("error group lookup across a reset", () => {
  // Mutation: dropping the resetKey/what check writes the old error onto the new draft.
  it("drops a lookup that resolves after the draft was reset", async () => {
    let finish!: (group: ErrorGroupOption) => void;
    const resolveErrorGroup = vi.fn(
      () => new Promise<ErrorGroupOption | undefined>((resolve) => (finish = resolve))
    );
    const onPatchApplied = vi.fn();
    let agent: CreationAgentSend | undefined;
    function Harness({ answers, resetKey }: { answers: FlowAnswers; resetKey: number }) {
      const send = useCreationAgentSend({ answers, onPatchApplied, resetKey, resolveErrorGroup });
      useEffect(() => {
        agent = send;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness, { answers: {}, resetKey: 0 })));
    act(() =>
      agent!.handleDraftPatches([
        {
          ok: true,
          patch: {
            area: "errors",
            what: "errors.occurred_again",
            scope: { type: "errorGroup", errorId: "error_abc" },
          },
        },
      ])
    );
    expect(onPatchApplied).toHaveBeenCalledTimes(1);
    act(() => root.render(createElement(Harness, { answers: {}, resetKey: 1 })));
    await act(async () => {
      finish({ taskIdentifier: "t", fingerprint: "abc", label: "t · abc" });
      await Promise.resolve();
    });
    expect(onPatchApplied).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  // Mutation: dropping the sequence/scope check lets the late lookup overwrite the pick.
  it("drops a lookup that resolves after the scope was picked manually", async () => {
    let finish!: (group: ErrorGroupOption) => void;
    const resolveErrorGroup = vi.fn(
      () => new Promise<ErrorGroupOption | undefined>((resolve) => (finish = resolve))
    );
    const onPatchApplied = vi.fn();
    let agent: CreationAgentSend | undefined;
    function Harness({ answers }: { answers: FlowAnswers }) {
      const send = useCreationAgentSend({
        answers,
        onPatchApplied,
        resetKey: 0,
        resolveErrorGroup,
      });
      useEffect(() => {
        agent = send;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness, { answers: {} })));
    act(() =>
      agent!.handleDraftPatches([
        {
          ok: true,
          patch: {
            area: "errors",
            what: "errors.occurred_again",
            scope: { type: "errorGroup", errorId: "error_a" },
          },
        },
      ])
    );
    act(() =>
      root.render(
        createElement(Harness, {
          answers: { what: "errors.occurred_again", scope: "errorGroup", scopeValue: "B" },
        })
      )
    );
    await act(async () => {
      finish({ taskIdentifier: "t", fingerprint: "a", label: "t · a" });
      await Promise.resolve();
    });
    expect(onPatchApplied).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  // Mutation: deleting the seq check lets the older lookup overwrite the newer one.
  it("drops an older lookup that resolves after a newer one with an unchanged scope", async () => {
    const finishers: ((group: ErrorGroupOption | undefined) => void)[] = [];
    const resolveErrorGroup = vi.fn(
      () =>
        new Promise<ErrorGroupOption | undefined>((resolve) => {
          finishers.push(resolve);
        })
    );
    const onPatchApplied = vi.fn();
    let agent: CreationAgentSend | undefined;
    function Harness() {
      const [answers, setAnswers] = useState<FlowAnswers>({});
      const send = useCreationAgentSend({
        answers,
        onPatchApplied: (next) => {
          onPatchApplied(next);
          setAnswers(next);
        },
        resetKey: 0,
        resolveErrorGroup,
      });
      useEffect(() => {
        agent = send;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
    const patch = (errorId: string) => ({
      ok: true,
      patch: {
        area: "errors",
        what: "errors.occurred_again",
        scope: { type: "errorGroup", errorId },
      },
    });
    act(() => agent!.handleDraftPatches([patch("error_a")]));
    act(() => agent!.handleDraftPatches([patch("error_b")]));
    const group = { taskIdentifier: "t", fingerprint: "x", label: "t · x" };
    await act(async () => {
      finishers[1](undefined);
      await Promise.resolve();
    });
    await act(async () => {
      finishers[0](group);
      await Promise.resolve();
    });
    expect(onPatchApplied).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });
});

describe("useErrorGroupLookup staleness", () => {
  // Mutation: dropping the sequence check lets a late lookup overwrite a newer pick.
  it("drops a lookup that resolves after the scope was picked manually", async () => {
    let finish!: (group: ErrorGroupOption) => void;
    const resolve = vi.fn(() => new Promise<ErrorGroupOption | undefined>((r) => (finish = r)));
    const selectChip = vi.fn();
    const setScopeValue = vi.fn();
    let lookup: ((id: string) => void) | undefined;
    function Harness({ answers }: { answers: FlowAnswers }) {
      const flow = { answers, selectChip, setScopeValue } as unknown as CreationFlowState;
      const current = useErrorGroupLookup(flow, resolve).lookup;
      useEffect(() => {
        lookup = current;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness, { answers: {} })));
    act(() => lookup!("error_a"));
    act(() => root.render(createElement(Harness, { answers: { scope: "task", scopeValue: "B" } })));
    await act(async () => {
      finish({ taskIdentifier: "t", fingerprint: "a", label: "t · a" });
      await Promise.resolve();
    });
    expect(selectChip).not.toHaveBeenCalled();
    expect(setScopeValue).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  // Mutation: dropping the answers-change bump lets a lookup survive a flow reset.
  it("drops a lookup that resolves after the flow was reset", async () => {
    let finish!: (group: ErrorGroupOption) => void;
    const resolve = vi.fn(() => new Promise<ErrorGroupOption | undefined>((r) => (finish = r)));
    const selectChip = vi.fn();
    const setScopeValue = vi.fn();
    let lookup: ((id: string) => void) | undefined;
    function Harness({ answers }: { answers: FlowAnswers }) {
      const flow = { answers, selectChip, setScopeValue } as unknown as CreationFlowState;
      const current = useErrorGroupLookup(flow, resolve).lookup;
      useEffect(() => {
        lookup = current;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness, { answers: {} })));
    act(() => lookup!("error_a"));
    act(() => root.render(createElement(Harness, { answers: {} })));
    await act(async () => {
      finish({ taskIdentifier: "t", fingerprint: "a", label: "t · a" });
      await Promise.resolve();
    });
    expect(selectChip).not.toHaveBeenCalled();
    expect(setScopeValue).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  // Mutation: bumping the seq on every render drops lookups across plain re-renders.
  it("applies a lookup when the host re-renders with the same answers", async () => {
    let finish!: (group: ErrorGroupOption) => void;
    const resolve = vi.fn(() => new Promise<ErrorGroupOption | undefined>((r) => (finish = r)));
    const selectChip = vi.fn();
    const setScopeValue = vi.fn();
    const answers: FlowAnswers = {};
    let lookup: ((id: string) => void) | undefined;
    function Harness() {
      const flow = { answers, selectChip, setScopeValue } as unknown as CreationFlowState;
      const current = useErrorGroupLookup(flow, resolve).lookup;
      useEffect(() => {
        lookup = current;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
    act(() => lookup!("error_a"));
    act(() => root.render(createElement(Harness)));
    await act(async () => {
      finish({ taskIdentifier: "t", fingerprint: "a", label: "t · a" });
      await Promise.resolve();
    });
    expect(selectChip).toHaveBeenCalledWith("scope", "errorGroup");
    expect(setScopeValue).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  // Mutation: dropping the unmount cleanup lets a pending lookup apply after unmount.
  it("drops a lookup that resolves after the hook unmounted", async () => {
    let finish!: (group: ErrorGroupOption) => void;
    const resolve = vi.fn(() => new Promise<ErrorGroupOption | undefined>((r) => (finish = r)));
    const selectChip = vi.fn();
    const setScopeValue = vi.fn();
    const answers: FlowAnswers = {};
    let lookup: ((id: string) => void) | undefined;
    function Harness() {
      const flow = { answers, selectChip, setScopeValue } as unknown as CreationFlowState;
      const current = useErrorGroupLookup(flow, resolve).lookup;
      useEffect(() => {
        lookup = current;
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
    act(() => lookup!("error_a"));
    act(() => root.unmount());
    await act(async () => {
      finish({ taskIdentifier: "t", fingerprint: "a", label: "t · a" });
      await Promise.resolve();
    });
    expect(selectChip).not.toHaveBeenCalled();
    expect(setScopeValue).not.toHaveBeenCalled();
  });
});

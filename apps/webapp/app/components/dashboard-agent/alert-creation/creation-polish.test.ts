// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useCreationFlowState } from "./CreationFlow";
import type { CreationFlowState } from "./CreationFlow";
import { alertName, type FlowAnswers } from "./flow-state";
import { ChatRequestSchema } from "~/v3/services/alerts/alertDraft";

if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof (HTMLElement.prototype as any).scrollIntoView !== "function") {
  (HTMLElement.prototype as any).scrollIntoView = () => {};
}

describe("alertName length", () => {
  const long = "x".repeat(200);
  const cases: Record<string, FlowAnswers> = {
    threshold: {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: long,
      condition: "100",
    },
    absence: {
      area: "runs",
      what: "runs.created",
      scope: "task",
      scopeValue: long,
      condition: "60",
    },
    errorGroup: {
      area: "errors",
      what: "errors.occurred_again",
      scope: "errorGroup",
      scopeValue: `${long}#abcdef123456`,
    },
  };

  for (const [label, answers] of Object.entries(cases)) {
    it(`keeps ${label} names within the request limit`, () => {
      const name = alertName(answers);
      expect(name.length).toBeLessThanOrEqual(120);
      expect(
        ChatRequestSchema.safeParse({
          organizationId: "o",
          projectId: "p",
          environmentId: "e",
          name,
          form: {},
        }).error?.issues.some((i) => i.path[0] === "name")
      ).toBeFalsy();
    });
  }
});

describe("#15 alertName uses humanized names", () => {
  it("fails when alertName returns raw capability title instead of humanized name (mutation: using cap.title)", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
    };
    const name = alertName(answers);
    expect(name).not.toBe("Queue depth alert");
    expect(name).toContain("Queue depth above 100");
    expect(name).toContain("all queues");
  });

  it("includes scope value when not 'all'", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: "worker-fast",
      condition: "200",
    };
    const name = alertName(answers);
    expect(name).toContain("200");
    expect(name).toContain("worker-fast");
  });

  it("fails when absence uses 'above' instead of 'No ... for' (mutation: treating absence like threshold)", () => {
    const answers: FlowAnswers = {
      area: "runs",
      what: "runs.created",
      scope: "all",
      condition: "60",
    };
    const name = alertName(answers);
    expect(name).not.toContain("above");
    expect(name).toContain("No runs created for 60m");
    expect(name).toContain("all runs");
  });

  it("uses humanized phrase for state capabilities without condition", () => {
    const answers: FlowAnswers = {
      area: "queues",
      what: "queue.stalled",
      scope: "all",
    };
    const name = alertName(answers);
    expect(name).not.toBe("Queue stalled alert");
    expect(name).toBe("A queue stalling");
  });

  it("uses humanized phrase for health.all", () => {
    const answers: FlowAnswers = {
      area: "health",
      what: "health.all",
      scope: "all",
    };
    const name = alertName(answers);
    expect(name).not.toBe("Health (All) alert");
    expect(name).toBe("Overall health check");
  });
});

describe("ChatRequestSchema name field", () => {
  const base = {
    organizationId: "org_1",
    projectId: "proj_1",
    environmentId: "env_1",
    chatNotifier: "on" as const,
    chatId: "chat_1",
    form: {
      capabilityKey: "queue.depth",
      scopeType: "all" as const,
      conditionKind: "threshold" as const,
      operator: ">" as const,
      value: 100,
      windowMinutes: 5,
      notifierChannelIds: [],
    },
  };

  it("trims and caps name at 120 characters", () => {
    const long = "A".repeat(150);
    const parsed = ChatRequestSchema.safeParse({ ...base, name: `  ${long}  ` });
    expect(parsed.success).toBe(false);
  });

  it("coerces empty string to undefined (mutation: passing empty saves blank name)", () => {
    const parsed = ChatRequestSchema.safeParse({ ...base, name: "   " });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBeUndefined();
    }
  });

  it("passes a valid name through trimmed", () => {
    const parsed = ChatRequestSchema.safeParse({ ...base, name: "  Queue depth above 100  " });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("Queue depth above 100");
    }
  });
});

describe("#16 intermediate ok:false never reaches final transcript", () => {
  const capture = { flow: undefined as CreationFlowState | undefined };

  it("fails when a turn [ok:false, ok:true] renders both error and success (mutation: not clearing submitError)", async () => {
    let callCount = 0;
    function Harness() {
      const flow = useCreationFlowState((answers) => {
        callCount++;
        if (callCount === 1) return Promise.resolve(false);
        return Promise.resolve({ alertId: "alert_ok" });
      });
      // eslint-disable-next-line -- test harness captures the hook return
      capture.flow = flow;
      return createElement("div", null, [
        flow.submitError && createElement("span", { key: "err", "data-testid": "error" }, "error"),
        flow.created && createElement("span", { key: "ok", "data-testid": "created" }, "created"),
      ]);
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Harness)));

    const f = () => capture.flow!;

    act(() => f().selectChip("area", "queues"));
    act(() => f().selectChip("what", "queue.depth"));
    act(() => f().selectChip("scope", "all"));
    act(() => f().setCondition("100"));
    act(() => f().toggleNotifier("chat"));
    act(() => f().confirmNotifiers());

    await act(async () => {
      f().create();
    });
    expect(f().submitError).toBe(true);
    expect(f().created).toBe(false);
    expect(container.querySelector("[data-testid='error']")).not.toBeNull();
    expect(container.querySelector("[data-testid='created']")).toBeNull();

    await act(async () => {
      f().create();
    });
    expect(f().submitError).toBe(false);
    expect(f().created).toBe(true);
    expect(container.querySelector("[data-testid='error']")).toBeNull();
    expect(container.querySelector("[data-testid='created']")).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it("fails when a systemLine from an ok:false turn persists after ok:true (mutation: not clearing lines)", async () => {
    let callCount = 0;
    function Harness() {
      const flow = useCreationFlowState((answers) => {
        callCount++;
        if (callCount === 1) return Promise.resolve(false);
        return Promise.resolve({ alertId: "alert_ok" });
      });
      // eslint-disable-next-line -- test harness captures the hook return
      capture.flow = flow;
      return createElement("div", null, [
        flow.submitError &&
          createElement("span", { key: "err", "data-testid": "sys-error" }, "Failed to create"),
        flow.created &&
          createElement("span", { key: "ok", "data-testid": "sys-created" }, "Created"),
        !flow.submitError &&
          !flow.created &&
          createElement("span", { key: "idle", "data-testid": "sys-idle" }, "Idle"),
      ]);
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Harness)));
    const f = () => capture.flow!;

    act(() => f().selectChip("area", "queues"));
    act(() => f().selectChip("what", "queue.depth"));
    act(() => f().selectChip("scope", "all"));
    act(() => f().setCondition("100"));
    act(() => f().toggleNotifier("chat"));
    act(() => f().confirmNotifiers());

    await act(async () => {
      f().create();
    });
    expect(container.querySelector("[data-testid='sys-error']")).not.toBeNull();
    expect(container.querySelector("[data-testid='sys-created']")).toBeNull();

    await act(async () => {
      f().create();
    });
    expect(container.querySelector("[data-testid='sys-error']")).toBeNull();
    expect(container.querySelector("[data-testid='sys-created']")).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});

describe("synchronous onSubmit failure", () => {
  it("sets submitError and leaves created false for a sync false (mutation: skipping the await)", async () => {
    const capture = { flow: undefined as CreationFlowState | undefined };
    function Harness() {
      const flow = useCreationFlowState(() => false);
      // eslint-disable-next-line -- test harness captures the hook return
      capture.flow = flow;
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Harness)));
    const f = () => capture.flow!;

    act(() => f().selectChip("area", "queues"));
    act(() => f().selectChip("what", "queue.depth"));
    act(() => f().selectChip("scope", "all"));
    act(() => f().setCondition("100"));
    act(() => f().toggleNotifier("chat"));
    act(() => f().confirmNotifiers());
    await act(async () => {
      f().create();
    });
    expect(f().submitError).toBe(true);
    expect(f().created).toBe(false);
    act(() => root.unmount());
    container.remove();
  });
});

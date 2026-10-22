import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { CreationTranscript, type SystemLine } from "~/components/alerts/CreationTranscript";
import { CreationChatShell } from "~/components/alerts/CreationChatShell";
import type { CreationFlowState } from "./CreationFlow";
import { draftMissing, EXPIRY_CHIPS, type FlowAnswers, type FlowStepKey } from "./flow-state";
import { alertDraftPatchSchema as contractPatchSchema } from "@internal/dashboard-agent-contracts";
import {
  alertDraftPatchSchema,
  applyDraftPatch,
  errorGroupToResolve,
  type AlertDraftPatch,
} from "./draftPatch";
import { draftResultLines } from "./useCreationAgentSend";

const panelSource = readFileSync(new URL("../DashboardAgentPanel.tsx", import.meta.url), "utf8");

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
    patchAnswers: noop,
    ...overrides,
  };
}

function wrap(el: React.ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, el)
    )
  );
}

describe("applyDraftPatch", () => {
  // Mutation: restoring a 24h cap or an expiry enum in the contract fails this.
  it("takes an expiry beyond 24h as a custom value", () => {
    for (const expiry of ["37h", "30d", "none", "2027-01-02T03:04:00.000Z"]) {
      expect(contractPatchSchema.safeParse({ behavior: { expiry } }).success).toBe(true);
    }
    const patch = alertDraftPatchSchema.parse({ behavior: { expiry: "37h" } });
    const next = applyDraftPatch({ area: "queues" }, patch);
    expect(next.expiry).toBe("37h");
    expect(EXPIRY_CHIPS.some((chip) => chip.value === next.expiry)).toBe(false);
    expect(applyDraftPatch({}, { behavior: { expiry: "30d" } }).expiry).toBe("720h");
  });

  // Mutation: retaining scope/condition on a capability change fails this.
  it("resets capability-dependent fields when the capability changes", () => {
    const base: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "queue",
      scopeValue: "payments",
      condition: "100",
      windowMinutes: 5,
      notifiers: ["chat"],
      expiry: "24h",
    };
    const next = applyDraftPatch(base, { what: "runs.failure_rate" });
    expect(next).toMatchObject({ what: "runs.failure_rate", notifiers: ["chat"], expiry: "24h" });
    expect(next.scope).toBeUndefined();
    expect(next.scopeValue).toBeUndefined();
    expect(next.condition).toBeUndefined();
    expect(next.windowMinutes).toBeUndefined();
    expect(
      applyDraftPatch(base, { what: "runs.failure_rate", condition: { value: 7 } }).condition
    ).toBe("7");
  });

  // Mutation: always clearing the scope fails this.
  it("keeps a scope the new capability still allows", () => {
    const base: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
    };
    const next = applyDraftPatch(base, { what: "queue.oldest_age" });
    expect(next.scope).toBe("all");
    expect(next.condition).toBeUndefined();
  });

  // Mutation: resetting when the patch repeats the same what fails this.
  it("keeps the condition when the patch repeats the same capability", () => {
    const base: FlowAnswers = {
      area: "queues",
      what: "queue.depth",
      scope: "all",
      condition: "100",
    };
    const next = applyDraftPatch(base, { what: "queue.depth" });
    expect(next.condition).toBe("100");
    expect(next.scope).toBe("all");
  });

  // Mutation: removing the errorGroup branch in applyDraftPatch fails this.
  it("resolves an error group patch to the errorGroup scope", () => {
    const patch = alertDraftPatchSchema.parse({
      area: "errors",
      what: "errors.occurred_again",
      scope: { type: "errorGroup", errorId: "error_744b4159", taskIdentifier: "sync-inventory" },
    });
    expect(applyDraftPatch({}, patch)).toEqual({
      area: "errors",
      what: "errors.occurred_again",
      scope: "errorGroup",
      scopeValue: "sync-inventory#744b4159",
    });
    const unresolved = alertDraftPatchSchema.parse({
      scope: { type: "errorGroup", errorId: "error_x" },
    });
    expect(applyDraftPatch({}, unresolved).scope).toBeUndefined();
    expect(errorGroupToResolve(unresolved)).toBe("error_x");
  });

  it("fails when applyDraftPatch drops condition.params", () => {
    const base: FlowAnswers = { area: "health", what: "health.composite" };
    const patch: AlertDraftPatch = {
      condition: {
        params: { cpuThreshold: 90, memoryThreshold: 85 },
      },
    };
    const result = applyDraftPatch(base, patch);
    expect(result.conditionParams).toEqual({ cpuThreshold: 90, memoryThreshold: 85 });
  });

  it("maps scope.type and scope.value to scopeType and scopeValue", () => {
    const base: FlowAnswers = { area: "queues" };
    const patch: AlertDraftPatch = {
      scope: { type: "queue", value: "my-queue" },
    };
    const result = applyDraftPatch(base, patch);
    expect(result.scope).toBe("queue");
    expect(result.scopeValue).toBe("my-queue");
  });

  it("maps condition.windowSec to windowMinutes", () => {
    const base: FlowAnswers = { area: "queues", what: "queues.depth" };
    const patch: AlertDraftPatch = {
      condition: { value: 100, windowSec: 600 },
    };
    const result = applyDraftPatch(base, patch);
    expect(result.condition).toBe("100");
    expect(result.windowMinutes).toBe(10);
  });

  it("maps behavior.expiry", () => {
    const base: FlowAnswers = {};
    const patch: AlertDraftPatch = {
      behavior: { expiry: "24h" },
    };
    const result = applyDraftPatch(base, patch);
    expect(result.expiry).toBe("24h");
  });
});

describe("chip clicks do not call the agent", () => {
  it("fails when a chip click triggers the agent call", () => {
    const transcriptSource = ["CreationTranscript.tsx", "wizardSteps.ts"]
      .map((file) => readFileSync(new URL(`../../alerts/${file}`, import.meta.url), "utf8"))
      .join("\n");
    const chipHandler = transcriptSource.match(/flow\.selectChip\(/g);
    expect(chipHandler).not.toBeNull();
    expect(chipHandler!.length).toBeGreaterThan(0);

    expect(transcriptSource).not.toMatch(/selectChip[^}]*sendFreeText/);
    expect(transcriptSource).not.toMatch(/selectChip[^}]*agentSend/);

    expect(panelSource).toMatch(/onFreeText={sendCreationText}/);
  });
});

describe("ok:false tool result does not mutate draft", () => {
  it("fails when an ok:false tool result mutates the draft", () => {
    const hookSource = readFileSync(new URL("./useCreationAgentSend.ts", import.meta.url), "utf8");
    const okFalseBlock = hookSource.match(/!result\.ok[\s\S]*?setSystemLines/);
    expect(okFalseBlock).not.toBeNull();

    expect(hookSource).not.toMatch(/!result\.ok[\s\S]{0,200}?onPatchApplied/);
  });
});

describe("reason line rendering", () => {
  it("fails when the reason line is not rendered after a patch", () => {
    const lines: SystemLine[] = [
      { id: "test-1", text: "I updated the threshold to 100.", variant: "info" },
    ];
    const flow = makeFlow({ currentStep: "area" });
    const html = wrap(
      createElement(
        CreationChatShell,
        { placement: "docked" },
        createElement(CreationTranscript, {
          flow,
          systemLines: lines,
          onFreeText: noop,
        })
      )
    );
    expect(html).toContain("I updated the threshold to 100.");
    expect(html).toContain('data-testid="system-line-info"');
  });
});

describe("scope value on scope type change", () => {
  const base: FlowAnswers = { what: "queue.depth", scope: "queue", scopeValue: "payments" };

  it("clears the value when the type changes without one", () => {
    const next = applyDraftPatch(base, { scope: { type: "task" } });
    expect(next.scopeValue).toBeUndefined();
    expect(draftMissing(next)).toContain("scope");
  });

  it("clears the value when switching to all", () => {
    expect(applyDraftPatch(base, { scope: { type: "all" } }).scopeValue).toBeUndefined();
  });

  it("does not resurrect a stale value when what changes and the old scope is re-sent", () => {
    const next = applyDraftPatch(
      { what: "queue.depth", scope: "queue", scopeValue: "payments" },
      { what: "runs.failure_rate", scope: { type: "queue" } }
    );
    expect(next.scopeValue).toBeUndefined();
  });

  it("keeps the value for a same-type patch without one", () => {
    expect(applyDraftPatch(base, { scope: { type: "queue" } }).scopeValue).toBe("payments");
  });
});

describe("below-threshold operator", () => {
  it("rejects operator < and surfaces an error line", () => {
    const patch = { condition: { operator: "<", value: 10 } };
    expect(alertDraftPatchSchema.safeParse(patch).success).toBe(false);
    expect(contractPatchSchema.safeParse(patch).success).toBe(false);
    expect(draftResultLines({ ok: true, patch: patch as never })[0]?.variant).toBe("error");
  });
});

describe("unknown-key rejection", () => {
  it("fails when a patch with an unknown key is applied client-side without rejection", () => {
    const result = alertDraftPatchSchema.safeParse({
      area: "queues",
      unknownField: "should-fail",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid patches", () => {
    const result = alertDraftPatchSchema.safeParse({
      area: "queues",
      what: "queues.depth",
      condition: { value: 50, params: { cpuThreshold: 80 } },
    });
    expect(result.success).toBe(true);
  });
});

describe("conditionParams in create request", () => {
  it("fails when conditionParams is dropped from the create request body", () => {
    expect(panelSource).toMatch(/conditionParams/);
    expect(panelSource).toMatch(
      /conditionParams:\s*\n?\s*kind\s*===\s*["']state["']\s*&&\s*answers\.conditionParams/
    );
  });

  it("conditionParams is in the ChatFormSchema", () => {
    const draftSource = readFileSync(
      new URL("../../../v3/services/alerts/alertDraft.ts", import.meta.url),
      "utf8"
    );
    expect(draftSource).toContain("conditionParams:");
  });

  it("buildCondition passes params for state kind", () => {
    const draftSource = readFileSync(
      new URL("../../../v3/services/alerts/alertDraft.ts", import.meta.url),
      "utf8"
    );
    expect(draftSource).toMatch(/case\s+["']state["'][\s\S]*?params:\s*v\.conditionParams/);
  });
});

import { describe, expect, it } from "vitest";
import {
  evaluateGate,
  type GateDependencies,
  type GateInputs,
  type TripDecision,
} from "~/v3/mollifier/mollifierGate.server";
import type { DecisionOutcome, DecisionReason } from "~/v3/mollifier/mollifierTelemetry.server";

// We deliberately don't use vi.fn here. Per repo policy tests shouldn't lean on
// mock frameworks for behaviours that are pure functions of the inputs — the
// gate is pure decision logic, so a hand-rolled "deps + spy log" wired with
// plain closures gives exactly the assertions we need without the indirection.
type Spies = {
  evaluatorCalls: number;
  logShadowCalls: Array<{ inputs: GateInputs; decision: Extract<TripDecision, { divert: true }> }>;
  logMollifiedCalls: Array<{ inputs: GateInputs; decision: Extract<TripDecision, { divert: true }> }>;
  recordDecisionCalls: Array<{ outcome: DecisionOutcome; reason?: DecisionReason }>;
};

type Toggles = {
  enabled: boolean;
  shadow: boolean;
  flag: boolean;
  decision: TripDecision;
};

function makeDeps(toggles: Toggles): { deps: GateDependencies; spies: Spies } {
  const spies: Spies = {
    evaluatorCalls: 0,
    logShadowCalls: [],
    logMollifiedCalls: [],
    recordDecisionCalls: [],
  };
  const deps: GateDependencies = {
    isMollifierEnabled: () => toggles.enabled,
    isShadowModeOn: () => toggles.shadow,
    resolveFlag: async () => toggles.flag,
    evaluator: async () => {
      spies.evaluatorCalls += 1;
      return toggles.decision;
    },
    logShadow: (inputs, decision) => {
      spies.logShadowCalls.push({ inputs, decision });
    },
    logMollified: (inputs, decision) => {
      spies.logMollifiedCalls.push({ inputs, decision });
    },
    recordDecision: (outcome, reason) => {
      spies.recordDecisionCalls.push({ outcome, reason });
    },
  };
  return { deps, spies };
}

const trippedDecision = {
  divert: true as const,
  reason: "per_env_rate" as const,
  count: 150,
  threshold: 100,
  windowMs: 200,
  holdMs: 500,
};

const passDecision: TripDecision = { divert: false };

const inputs: GateInputs = { envId: "e1", orgId: "o1", taskId: "t1" };

// Cascade truth table. Every combination of (enabled, shadow, flag, divert) is
// enumerated. `evaluatorCalls` is the expected count, not arbitrary: the gate
// short-circuits before the evaluator if `!enabled` or (`!flag && !shadow`).
// `expectedReason` is the optional second arg to `recordDecision` — only
// divert-true paths attach a reason.
type Row = {
  id: number;
  enabled: boolean;
  shadow: boolean;
  flag: boolean;
  divert: boolean;
  expected: {
    action: "pass_through" | "shadow_log" | "mollify";
    evaluatorCalls: 0 | 1;
    logShadowCalls: 0 | 1;
    logMollifiedCalls: 0 | 1;
    recordedOutcome: "pass_through" | "shadow_log" | "mollify";
    expectedReason: "per_env_rate" | undefined;
  };
};

// 16 rows = 2^4 input combinations. Comment column shows which gate branch
// each row exercises so reviewers can map row → code at a glance.
const cascade: Row[] = [
  // enabled=F → kill-switch wins; evaluator+flag never consulted (rows 1-8)
  { id: 1, enabled: false, shadow: false, flag: false, divert: false, expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 2, enabled: false, shadow: false, flag: false, divert: true,  expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 3, enabled: false, shadow: false, flag: true,  divert: false, expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 4, enabled: false, shadow: false, flag: true,  divert: true,  expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 5, enabled: false, shadow: true,  flag: false, divert: false, expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 6, enabled: false, shadow: true,  flag: false, divert: true,  expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 7, enabled: false, shadow: true,  flag: true,  divert: false, expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 8, enabled: false, shadow: true,  flag: true,  divert: true,  expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  // enabled=T, flag=F, shadow=F → both opt-ins off; evaluator never called (rows 9-10)
  { id: 9, enabled: true,  shadow: false, flag: false, divert: false, expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 10, enabled: true, shadow: false, flag: false, divert: true,  expected: { action: "pass_through", evaluatorCalls: 0, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  // enabled=T, flag=F, shadow=T → shadow path; divert routes outcome (rows 11-12)
  { id: 11, enabled: true, shadow: true,  flag: false, divert: false, expected: { action: "pass_through", evaluatorCalls: 1, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 12, enabled: true, shadow: true,  flag: false, divert: true,  expected: { action: "shadow_log",   evaluatorCalls: 1, logShadowCalls: 1, logMollifiedCalls: 0, recordedOutcome: "shadow_log",   expectedReason: "per_env_rate" } },
  // enabled=T, flag=T, shadow=F → mollify path (rows 13-14)
  { id: 13, enabled: true, shadow: false, flag: true,  divert: false, expected: { action: "pass_through", evaluatorCalls: 1, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 14, enabled: true, shadow: false, flag: true,  divert: true,  expected: { action: "mollify",      evaluatorCalls: 1, logShadowCalls: 0, logMollifiedCalls: 1, recordedOutcome: "mollify",      expectedReason: "per_env_rate" } },
  // enabled=T, flag=T, shadow=T → flag wins over shadow (rows 15-16)
  { id: 15, enabled: true, shadow: true,  flag: true,  divert: false, expected: { action: "pass_through", evaluatorCalls: 1, logShadowCalls: 0, logMollifiedCalls: 0, recordedOutcome: "pass_through", expectedReason: undefined } },
  { id: 16, enabled: true, shadow: true,  flag: true,  divert: true,  expected: { action: "mollify",      evaluatorCalls: 1, logShadowCalls: 0, logMollifiedCalls: 1, recordedOutcome: "mollify",      expectedReason: "per_env_rate" } },
];

describe("evaluateGate cascade — exhaustive truth table", () => {
  it.each(cascade)(
    "row $id: enabled=$enabled shadow=$shadow flag=$flag divert=$divert → action=$expected.action",
    async (row) => {
      const { deps, spies } = makeDeps({
        enabled: row.enabled,
        shadow: row.shadow,
        flag: row.flag,
        decision: row.divert ? trippedDecision : passDecision,
      });

      const outcome = await evaluateGate(inputs, deps);

      expect(outcome.action).toBe(row.expected.action);
      expect(spies.evaluatorCalls).toBe(row.expected.evaluatorCalls);
      expect(spies.logShadowCalls).toHaveLength(row.expected.logShadowCalls);
      expect(spies.logMollifiedCalls).toHaveLength(row.expected.logMollifiedCalls);

      // Every evaluation records exactly one decision.
      expect(spies.recordDecisionCalls).toHaveLength(1);
      expect(spies.recordDecisionCalls[0].outcome).toBe(row.expected.recordedOutcome);
      expect(spies.recordDecisionCalls[0].reason).toBe(row.expected.expectedReason);
    },
  );

  it("divert log carries the full decision (envId, orgId, taskId, reason, count, threshold, windowMs, holdMs)", async () => {
    const { deps, spies } = makeDeps({
      enabled: true,
      shadow: true,
      flag: false,
      decision: trippedDecision,
    });

    await evaluateGate(inputs, deps);

    expect(spies.logShadowCalls).toEqual([{ inputs, decision: trippedDecision }]);
  });

  it("mollify log carries the full decision (mirrors shadow log)", async () => {
    const { deps, spies } = makeDeps({
      enabled: true,
      shadow: false,
      flag: true,
      decision: trippedDecision,
    });

    await evaluateGate(inputs, deps);

    expect(spies.logMollifiedCalls).toEqual([{ inputs, decision: trippedDecision }]);
  });
});

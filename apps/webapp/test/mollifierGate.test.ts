import { describe, expect, it, vi } from "vitest";

// Stub `~/db.server` before importing anything that transitively imports it.
// The real module eagerly calls `prisma.$connect()` at singleton construction
// (db.server.ts), so loading it under vitest tries to reach localhost:5432
// and surfaces as an unhandled rejection that fails the whole shard — even
// though no test in this file actually uses the default prisma client.
// `postgresTest` provides its own container-backed prisma via the fixture.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { postgresTest } from "@internal/testcontainers";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import {
  evaluateGate,
  makeResolveMollifierFlag,
  type GateDependencies,
  type GateInputs,
  type TripDecision,
} from "~/v3/mollifier/mollifierGate.server";
import type { DecisionOutcome, DecisionReason } from "~/v3/mollifier/mollifierTelemetry.server";

// Each `postgresTest` boots its own Postgres container; the 5s vitest default
// regularly times out on CI just on container start. Match the timeout used by
// other postgresTest suites in this app (e.g. `taskIdentifierRegistry.test.ts`).
vi.setConfig({ testTimeout: 30_000 });

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
    resolveOrgFlag: async () => toggles.flag,
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

const inputs: GateInputs = {
  envId: "e1",
  orgId: "o1",
  taskId: "t1",
  orgFeatureFlags: null,
};

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

// The gate must opt in single orgs without affecting the others. These tests
// exercise the *real* `resolveOrgFlag` against a real Postgres testcontainer:
// we build it via `makeFlag(prisma)` and let the `Organization.featureFlags`
// blob flow through `flag()`'s overrides path. The global `FeatureFlag` table
// is empty, so the only signal moving outcomes is the per-org JSON.
// Hot-path guard: `triggerTask.server.ts` calls `evaluateGate` on every
// trigger when `MOLLIFIER_ENABLED=1`. The per-org override path must resolve
// without a Prisma round-trip — otherwise the gate adds a DB query to the
// highest-throughput code path in the system (see apps/webapp/CLAUDE.md).
describe("resolveMollifierFlag — hot path", () => {
  it("returns override value without calling flag() when override is set", async () => {
    let flagCalls = 0;
    const flagStub: any = async () => {
      flagCalls += 1;
      return false;
    };
    const resolve = makeResolveMollifierFlag(flagStub);

    const enabled = await resolve({
      envId: "e",
      orgId: "o",
      taskId: "t",
      orgFeatureFlags: { mollifierEnabled: true },
    });
    const disabled = await resolve({
      envId: "e",
      orgId: "o",
      taskId: "t",
      orgFeatureFlags: { mollifierEnabled: false },
    });

    expect(enabled).toBe(true);
    expect(disabled).toBe(false);
    expect(flagCalls).toBe(0);
  });

  it("falls back to flag() when org has no override for the key", async () => {
    let flagCalls = 0;
    const flagStub: any = async () => {
      flagCalls += 1;
      return true;
    };
    const resolve = makeResolveMollifierFlag(flagStub);

    const fromNull = await resolve({
      envId: "e",
      orgId: "o",
      taskId: "t",
      orgFeatureFlags: null,
    });
    const fromUnrelatedKeys = await resolve({
      envId: "e",
      orgId: "o",
      taskId: "t",
      orgFeatureFlags: { hasAiAccess: true },
    });

    expect(fromNull).toBe(true);
    expect(fromUnrelatedKeys).toBe(true);
    expect(flagCalls).toBe(2);
  });
});

describe("evaluateGate — fail open on evaluator error", () => {
  it("treats a throwing evaluator as no-divert (pass_through), and never blocks the trigger", async () => {
    const spies: Spies = {
      evaluatorCalls: 0,
      logShadowCalls: [],
      logMollifiedCalls: [],
      recordDecisionCalls: [],
    };
    const deps: Partial<GateDependencies> = {
      isMollifierEnabled: () => true,
      isShadowModeOn: () => false,
      resolveOrgFlag: async () => true,
      evaluator: async () => {
        spies.evaluatorCalls += 1;
        throw new Error("simulated evaluator failure");
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

    const outcome = await evaluateGate(inputs, deps);

    expect(outcome.action).toBe("pass_through");
    expect(spies.evaluatorCalls).toBe(1);
    expect(spies.logMollifiedCalls).toHaveLength(0);
    expect(spies.logShadowCalls).toHaveLength(0);
    expect(spies.recordDecisionCalls).toEqual([{ outcome: "pass_through", reason: undefined }]);
  });
});

describe("evaluateGate — fail open on resolveOrgFlag error", () => {
  it("treats org flag as false when resolveOrgFlag throws, and does not block triggers", async () => {
    const spies: Spies = {
      evaluatorCalls: 0,
      logShadowCalls: [],
      logMollifiedCalls: [],
      recordDecisionCalls: [],
    };
    const deps: Partial<GateDependencies> = {
      isMollifierEnabled: () => true,
      isShadowModeOn: () => false,
      resolveOrgFlag: async () => {
        throw new Error("simulated prisma timeout");
      },
      evaluator: async () => {
        spies.evaluatorCalls += 1;
        return trippedDecision;
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

    const outcome = await evaluateGate(inputs, deps);

    expect(outcome.action).toBe("pass_through");
    expect(spies.evaluatorCalls).toBe(0);
    expect(spies.recordDecisionCalls).toEqual([{ outcome: "pass_through", reason: undefined }]);
  });
});

describe("evaluateGate — per-org isolation via Organization.featureFlags", () => {
  function makeIsolationDeps(
    realResolveOrgFlag: GateDependencies["resolveOrgFlag"],
  ): { deps: Partial<GateDependencies>; spies: Spies } {
    const spies: Spies = {
      evaluatorCalls: 0,
      logShadowCalls: [],
      logMollifiedCalls: [],
      recordDecisionCalls: [],
    };
    // Override lifecycle bits and inject the real DB-backed resolveOrgFlag.
    // Evaluator returns a fixed tripped decision so the outcome is purely a
    // function of the flag resolution (which is what we're isolating on).
    const deps: Partial<GateDependencies> = {
      isMollifierEnabled: () => true,
      isShadowModeOn: () => false,
      resolveOrgFlag: realResolveOrgFlag,
      evaluator: async () => {
        spies.evaluatorCalls += 1;
        return trippedDecision;
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

  // Build the production resolveOrgFlag wired to the test Prisma client. This
  // is exactly the closure `defaultGateDependencies.resolveOrgFlag` runs in
  // prod — the only swap is the Prisma instance.
  function realResolveOrgFlag(prisma: Parameters<typeof makeFlag>[0]) {
    const f = makeFlag(prisma);
    return (inputs: GateInputs) =>
      f({
        key: FEATURE_FLAG.mollifierEnabled,
        defaultValue: false,
        overrides: inputs.orgFeatureFlags ?? {},
      });
  }

  postgresTest(
    "opts in only the org whose featureFlags has mollifierEnabled=true",
    async ({ prisma }) => {
      const resolve = realResolveOrgFlag(prisma);
      const orgA = { ...inputs, orgId: "org_a", orgFeatureFlags: { mollifierEnabled: true } };
      const orgB = { ...inputs, orgId: "org_b", orgFeatureFlags: { mollifierEnabled: false } };
      const orgC = { ...inputs, orgId: "org_c", orgFeatureFlags: null };

      const a = makeIsolationDeps(resolve);
      const b = makeIsolationDeps(resolve);
      const c = makeIsolationDeps(resolve);

      const [outcomeA, outcomeB, outcomeC] = await Promise.all([
        evaluateGate(orgA, a.deps),
        evaluateGate(orgB, b.deps),
        evaluateGate(orgC, c.deps),
      ]);

      // Only org A's flag is on → only org A mollifies. Orgs B and C never
      // reach the evaluator because both flag and shadow-mode are off.
      expect(outcomeA.action).toBe("mollify");
      expect(outcomeB.action).toBe("pass_through");
      expect(outcomeC.action).toBe("pass_through");

      expect(a.spies.evaluatorCalls).toBe(1);
      expect(b.spies.evaluatorCalls).toBe(0);
      expect(c.spies.evaluatorCalls).toBe(0);

      expect(a.spies.logMollifiedCalls).toHaveLength(1);
      expect(b.spies.logMollifiedCalls).toHaveLength(0);
      expect(c.spies.logMollifiedCalls).toHaveLength(0);
    },
  );

  postgresTest(
    "another org's beta flags must not opt them into mollifier",
    async ({ prisma }) => {
      const resolve = realResolveOrgFlag(prisma);
      // Org A has mollifier on (plus an unrelated beta).
      const orgA = {
        ...inputs,
        orgId: "org_a",
        orgFeatureFlags: { mollifierEnabled: true, hasComputeAccess: true },
      };
      // Org B has *other* betas on but mollifier remains off — keys that gate
      // compute/AI/query must not bleed across into the mollifier decision.
      const orgB = {
        ...inputs,
        orgId: "org_b",
        orgFeatureFlags: { hasComputeAccess: true, hasAiAccess: true },
      };

      const a = makeIsolationDeps(resolve);
      const b = makeIsolationDeps(resolve);

      const outcomeA = await evaluateGate(orgA, a.deps);
      const outcomeB = await evaluateGate(orgB, b.deps);

      expect(outcomeA.action).toBe("mollify");
      expect(outcomeB.action).toBe("pass_through");
    },
  );

  postgresTest(
    "global FeatureFlag row enables only when an org's overrides don't say otherwise",
    async ({ prisma }) => {
      // Set the global flag on. The repo-wide `flag()` helper checks
      // overrides first, then global, then default. So:
      //   - org with explicit `mollifierEnabled: false` → stays off.
      //   - org with no override → picks up the global on.
      //   - org with explicit `true` → on.
      await prisma.featureFlag.create({
        data: { key: FEATURE_FLAG.mollifierEnabled, value: true },
      });
      const resolve = realResolveOrgFlag(prisma);

      const orgOptedOut = {
        ...inputs,
        orgId: "org_opted_out",
        orgFeatureFlags: { mollifierEnabled: false },
      };
      const orgInherits = { ...inputs, orgId: "org_inherits", orgFeatureFlags: null };
      const orgExplicit = {
        ...inputs,
        orgId: "org_explicit",
        orgFeatureFlags: { mollifierEnabled: true },
      };

      const optedOut = makeIsolationDeps(resolve);
      const inherits = makeIsolationDeps(resolve);
      const explicit = makeIsolationDeps(resolve);

      const [outOptedOut, outInherits, outExplicit] = await Promise.all([
        evaluateGate(orgOptedOut, optedOut.deps),
        evaluateGate(orgInherits, inherits.deps),
        evaluateGate(orgExplicit, explicit.deps),
      ]);

      expect(outOptedOut.action).toBe("pass_through");
      expect(outInherits.action).toBe("mollify");
      expect(outExplicit.action).toBe("mollify");
    },
  );
});

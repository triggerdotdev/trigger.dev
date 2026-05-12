import { describe, expect, it, vi } from "vitest";
import {
  evaluateGate,
  type GateDependencies,
  type TripDecision,
} from "~/v3/mollifier/mollifierGate.server";

type Spies = {
  [K in keyof GateDependencies]: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<GateDependencies> = {}): {
  deps: GateDependencies;
  spies: Spies;
} {
  const defaults: GateDependencies = {
    isMollifierEnabled: () => false,
    isShadowModeOn: () => false,
    resolveOrgFlag: async () => false,
    evaluator: async () => ({ divert: false }) as TripDecision,
    logShadow: () => {},
  };
  const merged = { ...defaults, ...overrides };
  const spies = {
    isMollifierEnabled: vi.fn(merged.isMollifierEnabled),
    isShadowModeOn: vi.fn(merged.isShadowModeOn),
    resolveOrgFlag: vi.fn(merged.resolveOrgFlag),
    evaluator: vi.fn(merged.evaluator),
    logShadow: vi.fn(merged.logShadow),
  } satisfies Spies;
  return { deps: spies, spies };
}

describe("evaluateGate", () => {
  it("kill switch off: pass_through, evaluator NOT called, flag NOT consulted", async () => {
    const { deps, spies } = makeDeps({ isMollifierEnabled: () => false });
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, deps);

    expect(outcome).toEqual({ action: "pass_through" });
    expect(spies.evaluator).not.toHaveBeenCalled();
    expect(spies.resolveOrgFlag).not.toHaveBeenCalled();
  });

  it("kill switch on, org flag off, shadow off: pass_through, evaluator NOT called", async () => {
    const { deps, spies } = makeDeps({
      isMollifierEnabled: () => true,
      resolveOrgFlag: async () => false,
      isShadowModeOn: () => false,
    });
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, deps);

    expect(outcome).toEqual({ action: "pass_through" });
    expect(spies.evaluator).not.toHaveBeenCalled();
  });

  it("kill switch on, org flag off, shadow on, divert false: evaluator called, pass_through", async () => {
    const { deps, spies } = makeDeps({
      isMollifierEnabled: () => true,
      resolveOrgFlag: async () => false,
      isShadowModeOn: () => true,
      evaluator: async () => ({ divert: false }),
    });
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, deps);

    expect(outcome).toEqual({ action: "pass_through" });
    expect(spies.evaluator).toHaveBeenCalledOnce();
  });

  it("kill switch on, org flag off, shadow on, divert true: shadow_log (no mollify), logShadow called", async () => {
    const { deps, spies } = makeDeps({
      isMollifierEnabled: () => true,
      resolveOrgFlag: async () => false,
      isShadowModeOn: () => true,
      evaluator: async () => ({ divert: true, reason: "per_env_rate" }),
    });
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, deps);

    expect(outcome.action).toBe("shadow_log");
    expect(spies.logShadow).toHaveBeenCalledOnce();
    expect(spies.logShadow).toHaveBeenCalledWith(
      { envId: "e1", orgId: "o1" },
      "per_env_rate",
    );
  });

  it("kill switch on, org flag on, divert true: mollify, logShadow NOT called", async () => {
    const { deps, spies } = makeDeps({
      isMollifierEnabled: () => true,
      resolveOrgFlag: async () => true,
      evaluator: async () => ({ divert: true, reason: "per_env_rate" }),
    });
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, deps);

    expect(outcome.action).toBe("mollify");
    expect(spies.logShadow).not.toHaveBeenCalled();
  });

  it("kill switch on, org flag on, divert false: pass_through", async () => {
    const { deps } = makeDeps({
      isMollifierEnabled: () => true,
      resolveOrgFlag: async () => true,
      evaluator: async () => ({ divert: false }),
    });
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, deps);

    expect(outcome).toEqual({ action: "pass_through" });
  });

  it("kill switch on, org flag on, shadow on, divert true: mollify (org flag wins over shadow)", async () => {
    const { deps, spies } = makeDeps({
      isMollifierEnabled: () => true,
      resolveOrgFlag: async () => true,
      isShadowModeOn: () => true,
      evaluator: async () => ({ divert: true, reason: "per_env_rate" }),
    });
    const outcome = await evaluateGate({ envId: "e1", orgId: "o1" }, deps);

    expect(outcome.action).toBe("mollify");
    expect(spies.logShadow).not.toHaveBeenCalled();
  });
});


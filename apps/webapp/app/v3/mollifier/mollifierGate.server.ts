import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { flag } from "~/v3/featureFlags.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";

export type TripDecision =
  | { divert: false }
  | { divert: true; reason: "per_env_rate" };

export type GateOutcome =
  | { action: "pass_through" }
  | { action: "mollify"; decision: Extract<TripDecision, { divert: true }> }
  | { action: "shadow_log"; decision: Extract<TripDecision, { divert: true }> };

export type GateInputs = {
  envId: string;
  orgId: string;
};

export type TripEvaluator = (inputs: GateInputs) => Promise<TripDecision>;

export type GateDependencies = {
  isMollifierEnabled: () => boolean;
  isShadowModeOn: () => boolean;
  resolveOrgFlag: () => Promise<boolean>;
  evaluator: TripEvaluator;
  logShadow: (inputs: GateInputs, reason: "per_env_rate") => void;
};

const stubTripEvaluator: TripEvaluator = async () => ({ divert: false });

export const defaultGateDependencies: GateDependencies = {
  isMollifierEnabled: () => env.MOLLIFIER_ENABLED === "1",
  isShadowModeOn: () => env.MOLLIFIER_SHADOW_MODE === "1",
  resolveOrgFlag: () =>
    flag({ key: FEATURE_FLAG.mollifierEnabled, defaultValue: false }),
  evaluator: stubTripEvaluator,
  logShadow: (inputs, reason) =>
    logger.info("mollifier shadow decision", {
      envId: inputs.envId,
      orgId: inputs.orgId,
      reason,
    }),
};

export async function evaluateGate(
  inputs: GateInputs,
  deps: Partial<GateDependencies> = {},
): Promise<GateOutcome> {
  const d = { ...defaultGateDependencies, ...deps };

  if (!d.isMollifierEnabled()) {
    return { action: "pass_through" };
  }

  const orgFlagEnabled = await d.resolveOrgFlag();
  const shadowOn = d.isShadowModeOn();

  if (!orgFlagEnabled && !shadowOn) {
    return { action: "pass_through" };
  }

  const decision = await d.evaluator(inputs);
  if (!decision.divert) {
    return { action: "pass_through" };
  }

  if (orgFlagEnabled) {
    return { action: "mollify", decision };
  }

  d.logShadow(inputs, decision.reason);
  return { action: "shadow_log", decision };
}

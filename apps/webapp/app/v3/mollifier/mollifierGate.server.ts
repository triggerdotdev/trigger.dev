import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { flag } from "~/v3/featureFlags.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { createRealTripEvaluator } from "./mollifierTripEvaluator.server";
import {
  recordDecision,
  type DecisionOutcome,
  type DecisionReason,
} from "./mollifierTelemetry.server";

// `count` is the *single-instance* fixed-window counter (INCR with a PEXPIRE
// armed on the first tick of each window — see `mollifierEvaluateTrip` in
// `packages/redis-worker/src/mollifier/buffer.ts`). It is not a fleet-wide
// aggregate: each webapp instance maintains its own Redis key, so the fleet
// effective ceiling is `instance_count * threshold`, and at a window boundary
// the instance can briefly admit up to ~2x threshold before tripping. The
// tripped marker is refreshed on every overage call, so a sustained burst
// holds the divert state until the rate falls below threshold within a
// window. Phase 2 consumers must not treat `count` as a global rate.
export type TripDecision =
  | { divert: false }
  | {
      divert: true;
      reason: "per_env_rate";
      count: number;
      threshold: number;
      windowMs: number;
      holdMs: number;
    };

export type GateOutcome =
  | { action: "pass_through" }
  | { action: "mollify"; decision: Extract<TripDecision, { divert: true }> }
  | { action: "shadow_log"; decision: Extract<TripDecision, { divert: true }> };

export type GateInputs = {
  envId: string;
  orgId: string;
  taskId: string;
  // Org-scoped flag overrides — taken from `Organization.featureFlags` on the
  // AuthenticatedEnvironment at the call site. The repo-wide `flag()` helper
  // queries the global `FeatureFlag` table; passing per-org overrides lets the
  // mollifier opt in a single org without touching the global row, matching
  // the pattern used by `canAccessAi`, `canAccessPrivateConnections`, and the
  // compute-template beta gate.
  orgFeatureFlags: Record<string, unknown> | null;
};

export type TripEvaluator = (inputs: GateInputs) => Promise<TripDecision>;

export type GateDependencies = {
  isMollifierEnabled: () => boolean;
  isShadowModeOn: () => boolean;
  resolveOrgFlag: (inputs: GateInputs) => Promise<boolean>;
  evaluator: TripEvaluator;
  logShadow: (
    inputs: GateInputs,
    decision: Extract<TripDecision, { divert: true }>,
  ) => void;
  logMollified: (
    inputs: GateInputs,
    decision: Extract<TripDecision, { divert: true }>,
  ) => void;
  recordDecision: (outcome: DecisionOutcome, reason?: DecisionReason) => void;
};

// `options` is a thunk so env reads happen per-evaluation, not at module load.
// Don't "simplify" to a plain object — Phase 2 dynamic config relies on the
// gate observing whichever env values are live at trigger time.
const defaultEvaluator = createRealTripEvaluator({
  getBuffer: () => getMollifierBuffer(),
  options: () => ({
    windowMs: env.MOLLIFIER_TRIP_WINDOW_MS,
    threshold: env.MOLLIFIER_TRIP_THRESHOLD,
    holdMs: env.MOLLIFIER_HOLD_MS,
  }),
});

function logDivertDecision(
  message: "mollifier.would_mollify" | "mollifier.mollified",
  inputs: GateInputs,
  decision: Extract<TripDecision, { divert: true }>,
): void {
  logger.info(message, {
    envId: inputs.envId,
    orgId: inputs.orgId,
    taskId: inputs.taskId,
    reason: decision.reason,
    count: decision.count,
    threshold: decision.threshold,
    windowMs: decision.windowMs,
    holdMs: decision.holdMs,
  });
}

export const defaultGateDependencies: GateDependencies = {
  isMollifierEnabled: () => env.MOLLIFIER_ENABLED === "1",
  isShadowModeOn: () => env.MOLLIFIER_SHADOW_MODE === "1",
  resolveOrgFlag: (inputs) =>
    flag({
      key: FEATURE_FLAG.mollifierEnabled,
      defaultValue: false,
      overrides: inputs.orgFeatureFlags ?? {},
    }),
  evaluator: defaultEvaluator,
  logShadow: (inputs, decision) =>
    logDivertDecision("mollifier.would_mollify", inputs, decision),
  logMollified: (inputs, decision) =>
    logDivertDecision("mollifier.mollified", inputs, decision),
  recordDecision,
};

export async function evaluateGate(
  inputs: GateInputs,
  deps: Partial<GateDependencies> = {},
): Promise<GateOutcome> {
  const d = { ...defaultGateDependencies, ...deps };

  if (!d.isMollifierEnabled()) {
    d.recordDecision("pass_through");
    return { action: "pass_through" };
  }

  const orgFlagEnabled = await d.resolveOrgFlag(inputs);
  const shadowOn = d.isShadowModeOn();

  if (!orgFlagEnabled && !shadowOn) {
    d.recordDecision("pass_through");
    return { action: "pass_through" };
  }

  const decision = await d.evaluator(inputs);
  if (!decision.divert) {
    d.recordDecision("pass_through");
    return { action: "pass_through" };
  }

  if (orgFlagEnabled) {
    d.logMollified(inputs, decision);
    d.recordDecision("mollify", decision.reason);
    return { action: "mollify", decision };
  }

  d.logShadow(inputs, decision);
  d.recordDecision("shadow_log", decision.reason);
  return { action: "shadow_log", decision };
}

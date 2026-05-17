import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import { createRealTripEvaluator } from "./mollifierTripEvaluator.server";
import {
  recordDecision,
  type DecisionOutcome,
  type DecisionReason,
} from "./mollifierTelemetry.server";

// `count` is the fleet-wide fixed-window counter for the env (INCR with a
// PEXPIRE armed on the first tick of each window — see
// `mollifierEvaluateTrip` in `packages/redis-worker/src/mollifier/buffer.ts`).
// All webapp replicas pointing at the same Redis share the key
// `mollifier:rate:${envId}`, so the threshold is the fleet-wide ceiling
// rather than a per-instance one. At a window boundary an env can briefly
// admit up to ~2x threshold across the fleet before tripping (fixed-window
// not sliding-window). The tripped marker is refreshed on every overage
// call, so a sustained burst holds the divert state until the rate falls
// below threshold within a window.
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

// DI seam type for consumers (e.g. triggerTask.server.ts) that inject the
// gate at construction time. Deliberately narrower than `evaluateGate`'s
// real signature — no `deps` param — because consumers only call it with
// inputs and rely on the module-level defaults.
export type MollifierEvaluateGate = (inputs: GateInputs) => Promise<GateOutcome>;

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
    windowMs: env.TRIGGER_MOLLIFIER_TRIP_WINDOW_MS,
    threshold: env.TRIGGER_MOLLIFIER_TRIP_THRESHOLD,
    holdMs: env.TRIGGER_MOLLIFIER_HOLD_MS,
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

// Resolve the per-org mollifier flag purely from the in-memory
// `Organization.featureFlags` JSON. No DB query — `triggerTask` is the
// trigger hot path and the webapp CLAUDE.md forbids adding Prisma calls
// there. The fleet-wide kill switch lives in `TRIGGER_MOLLIFIER_ENABLED`; rollout
// is per-org via the JSON, matching the pattern used by `canAccessAi`,
// `hasComputeAccess`, etc. There is no global `FeatureFlag` table read
// in this path by design.
export function makeResolveMollifierFlag(): (inputs: GateInputs) => Promise<boolean> {
  return (inputs) => {
    const override = inputs.orgFeatureFlags?.[FEATURE_FLAG.mollifierEnabled];
    if (override !== undefined) {
      const parsed = FeatureFlagCatalog[FEATURE_FLAG.mollifierEnabled].safeParse(override);
      if (parsed.success) {
        return Promise.resolve(parsed.data);
      }
    }
    return Promise.resolve(false);
  };
}

const resolveMollifierFlag = makeResolveMollifierFlag();

export const defaultGateDependencies: GateDependencies = {
  isMollifierEnabled: () => env.TRIGGER_MOLLIFIER_ENABLED === "1",
  isShadowModeOn: () => env.TRIGGER_MOLLIFIER_SHADOW_MODE === "1",
  resolveOrgFlag: resolveMollifierFlag,
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

  // Fail open: a transient DB error resolving the per-org flag must not
  // block triggers. Mirror the evaluator's fail-open posture in
  // `mollifierTripEvaluator.server.ts`.
  let orgFlagEnabled: boolean;
  try {
    orgFlagEnabled = await d.resolveOrgFlag(inputs);
  } catch (error) {
    logger.warn("mollifier.resolve_org_flag_failed", {
      envId: inputs.envId,
      orgId: inputs.orgId,
      taskId: inputs.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    orgFlagEnabled = false;
  }
  const shadowOn = d.isShadowModeOn();

  if (!orgFlagEnabled && !shadowOn) {
    d.recordDecision("pass_through");
    return { action: "pass_through" };
  }

  // Fail open on evaluator errors too. The default `createRealTripEvaluator`
  // catches its own errors and returns `{ divert: false }`, but injected or
  // future evaluators may not — keep the contract symmetric with the org
  // flag resolution above so the trigger hot path can never be broken by a
  // gate-internal failure.
  let decision: TripDecision;
  try {
    decision = await d.evaluator(inputs);
  } catch (error) {
    logger.warn("mollifier.evaluator_failed", {
      envId: inputs.envId,
      orgId: inputs.orgId,
      taskId: inputs.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    decision = { divert: false };
  }
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

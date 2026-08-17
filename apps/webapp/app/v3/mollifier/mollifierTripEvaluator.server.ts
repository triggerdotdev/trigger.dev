import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import type { GateInputs, TripDecision, TripEvaluator } from "./mollifierGate.server";

export type TripEvaluatorOptions = {
  // "per_env" (default) rate-limits each env independently. "global" rate-limits
  // the aggregate fleet-wide trigger.run rate via a single shared counter and
  // ignores per-env contributions — it protects shared infra (the primary DB)
  // from the aggregate rate that per-env tripping structurally cannot bound.
  mode?: "per_env" | "global";
  windowMs: number;
  threshold: number;
  holdMs: number;
};

export type CreateRealTripEvaluatorDeps = {
  getBuffer: () => MollifierBuffer | null;
  options: () => TripEvaluatorOptions;
};

export function createRealTripEvaluator(deps: CreateRealTripEvaluatorDeps): TripEvaluator {
  return async (inputs: GateInputs): Promise<TripDecision> => {
    const buffer = deps.getBuffer();
    if (!buffer) return { divert: false };

    const opts = deps.options();

    try {
      const { tripped, count } =
        opts.mode === "global"
          ? await buffer.evaluateTripGlobal(opts)
          : await buffer.evaluateTrip(inputs.envId, opts);
      if (!tripped) return { divert: false };

      return {
        divert: true,
        reason: opts.mode === "global" ? "global_rate" : "per_env_rate",
        count,
        threshold: opts.threshold,
        windowMs: opts.windowMs,
        holdMs: opts.holdMs,
      };
    } catch (err) {
      // Deliberate: no error counter here. Shadow mode means a silent miss is
      // harmless — fail-open is the safe direction. The error log + Sentry
      // capture is sufficient operability while this runs in shadow mode. Revisit
      // once buffer writes are the primary path and a missed evaluation has cost.
      logger.error("mollifier trip evaluator: fail-open on error", {
        envId: inputs.envId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { divert: false };
    }
  };
}

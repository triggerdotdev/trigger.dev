import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { logger } from "~/services/logger.server";
import type { GateInputs, TripDecision, TripEvaluator } from "./mollifierGate.server";

export type TripEvaluatorOptions = {
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
      const { tripped, count } = await buffer.evaluateTrip(inputs.envId, opts);
      if (!tripped) return { divert: false };

      return {
        divert: true,
        reason: "per_env_rate",
        count,
        threshold: opts.threshold,
        windowMs: opts.windowMs,
        holdMs: opts.holdMs,
      };
    } catch (err) {
      // Deliberate: no error counter here. Shadow mode means a silent miss is
      // harmless — fail-open is the safe direction. The error log + Sentry
      // capture is sufficient operability for Phase 1. Revisit in Phase 2
      // when buffer writes are the primary path and a missed evaluation has cost.
      logger.error("mollifier trip evaluator: fail-open on error", {
        envId: inputs.envId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { divert: false };
    }
  };
}

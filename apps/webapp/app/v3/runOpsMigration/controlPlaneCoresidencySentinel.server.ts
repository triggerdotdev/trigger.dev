/**
 * Advisory control-plane co-residency sentinel (Track 2, T2.3). Distinct from the HARD distinct-DB
 * interlock (legacy != new): this arm only OBSERVES whether the independent legacy run-ops DB is still
 * co-resident with the control-plane DB, emitting the `run_ops_legacy_control_plane_coresident` metric
 * + a log on every split-on boot. It NEVER fails boot on its own — same-DSN stage reads "true", cutover
 * flips it to "false", and rollback flips it back, all without blocking. Only when the operator opts in
 * via RUN_OPS_EXPECT_CONTROL_PLANE_SPLIT (weeks after cutover, once the rollback window closes) does a
 * positively-confirmed co-residency ("true") become a boot failure. "unknown" (denied probe) never
 * enforces.
 */
import type { Counter } from "@opentelemetry/api";
import { getMeter } from "@internal/tracing";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  probeControlPlaneCoresidency,
  type CoresidencyProbeResult,
  type CoresidencyVerdict,
} from "./distinctDbSentinel.server";

// Created lazily on first emit, NOT at module load: this module is imported by db.server before
// tracer.server registers the global meter provider, so a module-load counter would bind to the
// no-op provider permanently. The advisory runs from the entry-server boot path, after registration.
let coresidentCounter: Counter | undefined;
function getCoresidentCounter(): Counter {
  return (coresidentCounter ??= getMeter("run-ops-migration").createCounter(
    "run_ops_legacy_control_plane_coresident",
    {
      description:
        "Advisory: is the legacy run-ops DB co-resident with the control-plane DB at boot (true=same DB, false=split, unknown=probe denied)",
    }
  ));
}

export type CoresidencyEnforcement = { throw: false } | { throw: true; message: string };

// Pure decision: enforcement fires ONLY when the operator opted in AND co-residency was positively
// confirmed ("true"). "unknown" never enforces (a denied probe must not fail boot); "false" is the goal.
export function resolveCoresidencyEnforcement(args: {
  coresident: CoresidencyVerdict;
  expectSplit: boolean;
}): CoresidencyEnforcement {
  if (args.expectSplit && args.coresident === "true") {
    return {
      throw: true,
      message:
        "RUN_OPS_EXPECT_CONTROL_PLANE_SPLIT is on but the legacy run-ops DB is still co-resident with the control-plane DB; refusing to start.",
    };
  }
  return { throw: false };
}

type AdvisoryLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

export async function assertControlPlaneCoresidencyAdvisory(deps?: {
  probe?: typeof probeControlPlaneCoresidency;
  emit?: (verdict: CoresidencyVerdict) => void;
  log?: AdvisoryLogger;
  expectSplit?: boolean;
  legacyUrl?: string;
  controlPlaneUrl?: string;
}): Promise<void> {
  const log = deps?.log ?? logger;
  const legacyUrl = deps?.legacyUrl ?? env.RUN_OPS_LEGACY_DATABASE_URL;
  const controlPlaneUrl =
    deps?.controlPlaneUrl ?? env.CONTROL_PLANE_DATABASE_URL ?? env.DATABASE_URL;
  // No legacy DSN (single-DB / self-host) or no control-plane DSN -> nothing to compare.
  if (!legacyUrl || !controlPlaneUrl) return;

  const probe = deps?.probe ?? probeControlPlaneCoresidency;
  const emit =
    deps?.emit ??
    ((verdict: CoresidencyVerdict) => getCoresidentCounter().add(1, { result: verdict }));
  const expectSplit = deps?.expectSplit ?? env.RUN_OPS_EXPECT_CONTROL_PLANE_SPLIT;

  let result: CoresidencyProbeResult;
  try {
    result = await probe(legacyUrl, controlPlaneUrl, { logger: log });
  } catch (error) {
    // Any unexpected throw still degrades to "unknown" — the advisory arm must never crash boot.
    log.warn("run-ops control-plane co-residency probe threw; reporting unknown", { error });
    result = { coresident: "unknown", reason: String(error) };
  }

  emit(result.coresident);
  log.info("run_ops_legacy_control_plane_coresident", {
    coresident: result.coresident,
    reason: "reason" in result ? result.reason : undefined,
    expectSplit,
  });

  const enforcement = resolveCoresidencyEnforcement({
    coresident: result.coresident,
    expectSplit,
  });
  if (enforcement.throw) {
    throw new Error(enforcement.message);
  }
}

import { getMeter } from "@internal/tracing";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import {
  createWorkerActionTokenVerifier,
  parseWorkerActionTokenConfig,
} from "./workerActionTokenVerifier.server";
import {
  createWorkerActionTokenGate,
  type WorkerActionTokenGateArgs,
  type WorkerActionTokenGateResult,
  type WorkerActionTokenOutcomeRecord,
  type WorkerActionTokenStartVersionArgs,
} from "./workerActionTokenGate.server";

export type {
  WorkerActionTokenGateResult,
  WorkerActionTokenStartVersion,
} from "./workerActionTokenGate.server";

const meter = getMeter("worker-action-token");

const workerActionTokenCounter = meter.createCounter("worker_action_token_total", {
  description: "Workload token outcomes on worker action run routes",
});

const QUIET_OUTCOMES = new Set(["verified", "global_exempt", "grandfathered"]);

function recordWorkerActionTokenOutcome({
  outcome,
  action,
  mode,
  worker,
  runFriendlyId,
  createdAfterCutoff,
}: WorkerActionTokenOutcomeRecord) {
  workerActionTokenCounter.add(1, {
    outcome,
    action,
    token_kind: worker.tokenKind,
    mode,
    created_after_cutoff: createdAfterCutoff,
  });

  if (!QUIET_OUTCOMES.has(outcome)) {
    logger.warn("[worker-action-token] outcome", {
      outcome,
      action,
      mode,
      runId: runFriendlyId,
      workerGroupId: worker.workerGroupId,
      instanceName: worker.name,
    });
  }
}

const gate = singleton("workerActionTokenGate", () => {
  const config = parseWorkerActionTokenConfig({
    modes: env.WORKER_ACTION_TOKEN_MODES,
    publicKeys: env.WORKLOAD_TOKEN_PUBLIC_KEYS,
    cutoff: env.WORKER_ACTION_TOKEN_CUTOFF,
  });

  return createWorkerActionTokenGate({
    config,
    verifier: createWorkerActionTokenVerifier(config.publicKeys),
    record: recordWorkerActionTokenOutcome,
  });
});

export function applyWorkerActionTokenGate(
  args: WorkerActionTokenGateArgs
): Promise<WorkerActionTokenGateResult> {
  return gate.apply(args);
}

export function assertWorkerActionTokenStartVersion(args: WorkerActionTokenStartVersionArgs) {
  gate.assertStartVersion(args);
}

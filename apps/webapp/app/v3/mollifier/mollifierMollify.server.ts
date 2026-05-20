import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { serialiseMollifierSnapshot, type MollifierSnapshot } from "./mollifierSnapshot.server";
import type { TripDecision } from "./mollifierGate.server";

export type MollifyNotice = {
  code: "mollifier.queued";
  message: string;
  docs: string;
};

export type MollifySyntheticResult = {
  run: { friendlyId: string };
  error: undefined;
  // The race-loser path (Q5): if accept's SETNX hit an existing
  // buffered run with the same (env, task, idempotencyKey), the
  // response echoes the winner's runId with isCached=true. The
  // mollifier-queued notice is only attached for the happy accept.
  isCached: boolean;
  notice?: MollifyNotice;
};

const NOTICE: MollifyNotice = {
  code: "mollifier.queued",
  message:
    "Trigger accepted into burst buffer. Consider batchTrigger for fan-outs of 100+.",
  docs: "https://trigger.dev/docs/triggering#burst-handling",
};

export async function mollifyTrigger(args: {
  runFriendlyId: string;
  environmentId: string;
  organizationId: string;
  engineTriggerInput: MollifierSnapshot;
  decision: Extract<TripDecision, { divert: true }>;
  buffer: MollifierBuffer;
  // Optional idempotency context. When both are passed, accept SETNXes
  // the lookup so the buffered window participates in trigger-time
  // dedup symmetrically with PG (Q5).
  idempotencyKey?: string;
  taskIdentifier?: string;
}): Promise<MollifySyntheticResult> {
  const result = await args.buffer.accept({
    runId: args.runFriendlyId,
    envId: args.environmentId,
    orgId: args.organizationId,
    payload: serialiseMollifierSnapshot(args.engineTriggerInput),
    idempotencyKey: args.idempotencyKey,
    taskIdentifier: args.taskIdentifier,
  });

  if (result.kind === "duplicate_idempotency") {
    // Race loser. Echo the winner's runId so the SDK's response shape
    // matches PG-side idempotency cache hits.
    return {
      run: { friendlyId: result.existingRunId },
      error: undefined,
      isCached: true,
    };
  }

  // Both "accepted" and "duplicate_run_id" produce the same customer-
  // visible response: a buffered-trigger acknowledgement. The duplicate
  // runId case is unreachable in practice (runIds are server-generated
  // and unique) but is silently idempotent at the buffer layer either way.
  return {
    run: { friendlyId: args.runFriendlyId },
    error: undefined,
    isCached: false,
    notice: NOTICE,
  };
}

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
  isCached: false;
  notice: MollifyNotice;
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
}): Promise<MollifySyntheticResult> {
  await args.buffer.accept({
    runId: args.runFriendlyId,
    envId: args.environmentId,
    orgId: args.organizationId,
    payload: serialiseMollifierSnapshot(args.engineTriggerInput),
  });

  return {
    run: { friendlyId: args.runFriendlyId },
    error: undefined,
    isCached: false,
    notice: NOTICE,
  };
}

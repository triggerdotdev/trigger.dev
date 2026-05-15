import { createHash } from "node:crypto";
import { MollifierDrainer, serialiseSnapshot } from "@trigger.dev/redis-worker";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { getMollifierBuffer } from "./mollifierBuffer.server";
import type { BufferedTriggerPayload } from "./bufferedTriggerPayload.server";

function initializeMollifierDrainer(): MollifierDrainer<BufferedTriggerPayload> {
  const buffer = getMollifierBuffer();
  if (!buffer) {
    // Unreachable in normal config: getMollifierDrainer() gates on the
    // same env flag as getMollifierBuffer(). If we hit this, fail loud
    // — the operator has set MOLLIFIER_ENABLED=1 on a worker pod but
    // the buffer can't initialise (e.g. MOLLIFIER_REDIS_HOST resolves
    // to nothing). Crashing surfaces the misconfig immediately rather
    // than silently leaving entries un-drained.
    throw new Error("MollifierDrainer initialised without a buffer — env vars inconsistent");
  }

  logger.debug("Initializing mollifier drainer", {
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
  });

  // Phase 1 handler: no-op ack. The trigger has ALREADY been written to
  // Postgres via engine.trigger (dual-write at the call site). Popping +
  // acking here proves the dequeue mechanism works end-to-end without
  // duplicating the work. Phase 2 will replace this with an engine.trigger
  // replay that performs the actual Postgres write.
  const drainer = new MollifierDrainer<BufferedTriggerPayload>({
    buffer,
    handler: async (input) => {
      // Hash the (re-serialised, canonical) payload on the drain side rather
      // than on the trigger hot path. Burst-time CPU stays with engine.trigger;
      // the drainer is the natural place for the audit-equivalence checksum.
      // Re-serialisation is identity for the BufferedTriggerPayload shape
      // (only strings/numbers/plain objects), so this hash matches what the
      // call site wrote into Redis.
      const reserialised = serialiseSnapshot(input.payload);
      const payloadHash = createHash("sha256").update(reserialised).digest("hex");
      logger.info("mollifier.drained", {
        runId: input.runId,
        envId: input.envId,
        orgId: input.orgId,
        taskId: input.payload.taskId,
        attempts: input.attempts,
        ageMs: Date.now() - input.createdAt.getTime(),
        payloadBytes: reserialised.length,
        payloadHash,
      });
    },
    concurrency: env.MOLLIFIER_DRAIN_CONCURRENCY,
    maxAttempts: env.MOLLIFIER_DRAIN_MAX_ATTEMPTS,
    maxOrgsPerTick: env.MOLLIFIER_DRAIN_MAX_ORGS_PER_TICK,
    // A no-op handler shouldn't throw, but if something does (e.g. an
    // unexpected deserialise failure), don't loop — let it FAIL terminally
    // so the entry is observable in metrics.
    isRetryable: () => false,
  });

  drainer.start();
  return drainer;
}

export function getMollifierDrainer(): MollifierDrainer<BufferedTriggerPayload> | null {
  if (env.MOLLIFIER_ENABLED !== "1") return null;
  return singleton("mollifierDrainer", initializeMollifierDrainer);
}

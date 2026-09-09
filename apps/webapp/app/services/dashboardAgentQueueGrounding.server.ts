import type { QueueGrounding } from "@internal/dashboard-agent-contracts";
import { $replica } from "~/db.server";
import { getQueue } from "~/presenters/v3/QueueRetrievePresenter.server";
import { engine } from "~/v3/runEngine.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";

/** Same cap the queue detail page reads keys with. */
const CK_LIMIT = 50;

export async function readQueueGrounding({
  environment,
  queueName,
  queueType,
}: {
  environment: AuthenticatedEnvironment;
  queueName: string;
  queueType: "task" | "custom";
}): Promise<QueueGrounding> {
  // V1 has no run-queue counters at all, so every number would be a zero it never scheduled.
  const engineVersion = await determineEngineVersion({ environment });
  if (engineVersion === "V1") {
    return { status: "unresolved", reason: "scheduler_unavailable" };
  }

  const queue = await getQueue($replica, environment, { type: queueType, name: queueName });

  if (!queue) {
    return { status: "unresolved", reason: "queue_not_found" };
  }

  try {
    const [
      queued,
      baseAdmitted,
      displayedByQueue,
      limit,
      envAdmitted,
      envLimit,
      envEffectiveLimit,
      envDisplayed,
      baseOldest,
      ck,
    ] = await Promise.all([
      engine.lengthOfQueue(environment, queue.name),
      engine.currentConcurrencyOfQueue(environment, queue.name),
      engine.currentConcurrencyOfQueues(environment, [queue.name]),
      engine.getQueueConcurrencyLimit(environment, queue.name),
      engine.operationalCurrentConcurrencyOfEnvironment(environment),
      engine.getEnvConcurrencyLimit(environment),
      engine.getEnvConcurrencyLimitWithBurstFactor(environment),
      engine.concurrencyOfEnvQueue(environment),
      engine.oldestMessageInQueue(environment, queue.name),
      engine.concurrencyKeyBreakdown(environment, queue.name, { limit: CK_LIMIT }),
    ]);

    const displayed = displayedByQueue[queue.name] ?? 0;

    // The queue gate SCARDs a per-key set for keyed work, so the base set stays 0 there.
    const keyed = ck.totalBackloggedKeys > 0 || displayed > baseAdmitted;

    const rows = ck.keys.map((row) => ({
      key: row.concurrencyKey,
      queued: row.queued,
      running: row.running,
      oldestAvailableAt: row.oldestEnqueuedAt,
    }));

    return {
      asOf: new Date().toISOString(),
      queue: {
        queued,
        admitted: baseAdmitted,
        keyed,
        paused: queue.paused,
        displayed,
        limit: limit ?? null,
        enforcedLimit: Math.min(limit ?? envLimit, envLimit),
      },
      env: {
        admitted: envAdmitted,
        limit: envLimit,
        effectiveLimit: envEffectiveLimit,
        displayed: envDisplayed,
      },
      // Earlier of the base head and the first (score-ascending) breakdown row.
      oldestAvailableAtMs: (() => {
        const candidates = [baseOldest, rows[0]?.oldestAvailableAt].filter(
          (value): value is number => typeof value === "number" && Number.isFinite(value)
        );
        return candidates.length > 0 ? Math.min(...candidates) : null;
      })(),
      concurrencyKeys: {
        total: ck.totalBackloggedKeys,
        truncated: ck.totalBackloggedKeys > rows.length,
        rows,
      },
      // Naming the runs holding the slots is a separate read; this reader never claims it.
      holders: { availability: "unavailable" },
    };
  } catch (error) {
    // A partial payload would read as spare capacity, so any failed counter fails the whole read.
    logger.warn("Failed to read queue grounding", {
      error,
      queue: queue.name,
      environmentId: environment.id,
    });
    return { status: "unresolved", reason: "scheduler_unavailable" };
  }
}

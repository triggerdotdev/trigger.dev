import { SKEW_PROTECTION_THRESHOLD_SIGNAL } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { findCurrentDeployment } from "~/v3/models/workerDeployment.server";
import { readSkewProtectionThresholds } from "~/v3/services/skewProtectionThresholds.server";
import { readLatestSignals, sendEnvironmentSignal, SignalError } from "./environmentSignals.server";
import {
  sameSkewProtectionThresholdSignal,
  skewProtectionThresholdSignalPayload,
  taskContinuesTurns,
} from "./turnHandoverState";

// Chat agents with `versionSkew: "follow-mid-turn"` move a running turn to the current deployment
// at its next step boundary when its version is below the skew protection threshold for its task.
// They learn the thresholds from one environment signal, `trigger.skew-protection-threshold`,
// whose payload is the thresholds' versions. Each run decides from its own version and task:
// nothing is looked up or written per run or per session.

/** How many times one sync sends before it leaves the signal to the next change. */
const SYNC_SENDS = 3;

/**
 * Bring the environment's `trigger.skew-protection-threshold` signal in line with its thresholds
 * and current deployment. Threshold set and clear call it after they commit; a promote or rollback
 * calls it after the current deployment changes (its agents decide `midTurnTasks`, and a
 * rollback can clear thresholds). Sends only when the payload differs from the latest signal.
 *
 * `changed: false` with no thresholds touches nothing (no stream read, so no S2 call per deploy
 * in environments without thresholds). Every change that emptied the thresholds came through
 * here; if its send failed, the signal stays stale until the threshold is cleared again (a
 * promote doesn't repair it).
 *
 * After a send it reads both again: two syncs that overlap (a set and a promote) can each read
 * the stream before the other appends, and the one with the older payload appends last. A
 * payload that no longer matches is sent again, at most {@link SYNC_SENDS} times. No lock is held
 * across the S2 calls.
 *
 * Never throws: the change is already committed, and a failed send is logged.
 */
export async function syncSkewProtectionThresholdSignal(
  environmentId: string,
  options: { changed: boolean }
): Promise<void> {
  try {
    let environment: Awaited<ReturnType<typeof findEnvironmentById>> | undefined;
    for (let sends = 0; ; sends++) {
      const row = await prisma.runtimeEnvironment.findFirst({
        where: { id: environmentId },
        select: { skewProtectionThresholds: true },
      });
      const thresholds = readSkewProtectionThresholds(row?.skewProtectionThresholds, environmentId);
      const none = !thresholds.environment && thresholds.tasks.size === 0;
      if (none && !options.changed && sends === 0) return;

      environment ??= await findEnvironmentById(environmentId);
      if (!environment) return;

      const current = none ? undefined : await findCurrentDeployment(environmentId, prisma);
      // On the (workerId, slug) unique index: the current deployment's agents.
      const agents = current?.workerId
        ? await prisma.backgroundWorkerTask.findMany({
            where: { workerId: current.workerId, triggerSource: "AGENT" },
            select: { slug: true, config: true },
          })
        : [];
      const payload = skewProtectionThresholdSignalPayload(
        thresholds,
        agents.filter((agent) => taskContinuesTurns(agent.config)).map((agent) => agent.slug)
      );
      const latest = (await readLatestSignals(environment)).find(
        (entry) => entry.name === SKEW_PROTECTION_THRESHOLD_SIGNAL && entry.task === undefined
      );
      if (sameSkewProtectionThresholdSignal(payload, latest?.payload)) return;
      if (sends >= SYNC_SENDS) {
        logger.warn("The skew protection threshold signal kept changing under its sync", {
          environmentId,
          sends,
        });
        return;
      }

      const { seq } = await sendEnvironmentSignal(
        environment,
        { name: SKEW_PROTECTION_THRESHOLD_SIGNAL, payload },
        { platform: true }
      );
      // Not `payload`: the logger filters that key. Versions and task ids only.
      logger.info("Sent the skew protection threshold signal", {
        environmentId,
        environmentThreshold: payload.environment,
        taskThresholds: payload.tasks,
        midTurnTasks: payload.midTurnTasks,
        seq,
        resend: sends > 0,
      });
    }
  } catch (error) {
    if (error instanceof SignalError && error.status === 501) {
      // No S2 realtime backend (self-hosted on v1): no signal to send, and turns move between turns.
      logger.debug("No skew protection threshold signal: signals need the S2 realtime backend", {
        environmentId,
      });
      return;
    }
    logger.error("Failed to send the skew protection threshold signal", { environmentId, error });
  }
}

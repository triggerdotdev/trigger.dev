import type { Session, TaskRunStatus } from "@trigger.dev/database";
import { SessionTriggerConfig as SessionTriggerConfigZod } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma, $replica } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { TriggerTaskService } from "~/v3/services/triggerTask.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

/**
 * Schema for `Session.triggerConfig` (stored as JSONB). The wire-format
 * source of truth lives in `@trigger.dev/core/v3` as `SessionTriggerConfig`;
 * we re-export it here for the trigger machinery to validate on read.
 *
 * `basePayload` carries the customer's wire payload (for chat.agent:
 * `{ chatId, ...clientData, idleTimeoutInSeconds? }`). Runtime fields
 * specific to a particular trigger (e.g. `trigger: "trigger" | "preload"`,
 * an `isContinuation` flag) come in via the `payloadOverrides` argument
 * to `ensureRunForSession` and shallow-merge on top of `basePayload`.
 */
export const SessionTriggerConfigSchema = SessionTriggerConfigZod;

export type SessionTriggerConfig = z.infer<typeof SessionTriggerConfigSchema>;

export type EnsureRunReason = "initial" | "continuation" | "upgrade" | "manual";

type EnsureRunForSessionParams = {
  /**
   * Session row to operate on. Caller is responsible for the env match —
   * we don't re-check `runtimeEnvironmentId` against `environment.id`.
   */
  session: Pick<
    Session,
    "id" | "taskIdentifier" | "triggerConfig" | "currentRunId" | "currentRunVersion"
  >;
  environment: AuthenticatedEnvironment;
  reason: EnsureRunReason;
  /**
   * Shallow-merged on top of `triggerConfig.basePayload`. Runtime fields
   * only — caller-controlled data that varies per trigger (`trigger:
   * "preload"` vs `"trigger"`, etc).
   */
  payloadOverrides?: Record<string, unknown>;
};

export type EnsureRunResult = {
  runId: string;
  /** True if this call triggered a fresh run; false if it reused an alive existing one. */
  triggered: boolean;
};

/**
 * Idempotently make sure the session has a live run.
 *
 * Algorithm:
 *   1. If `currentRunId` is set, probe its status. Alive → return as-is.
 *   2. Trigger a new run upfront (cheap to cancel if we lose the race).
 *   3. Atomic claim via `updateMany` keyed on `currentRunVersion`.
 *      - Won: return new runId, record SessionRun audit row.
 *      - Lost: cancel our triggered run, re-read session, reuse winner's
 *        run if alive. If pathological (winner's run already terminal),
 *        recurse.
 *
 * No DB lock is held across the trigger call. Wasted-trigger window is
 * the rare multi-tab race on a dead run; cancel cost is negligible and
 * the run-engine handles it gracefully.
 */
export async function ensureRunForSession(
  params: EnsureRunForSessionParams
): Promise<EnsureRunResult> {
  const { session, environment, reason, payloadOverrides } = params;

  // 1. Probe currentRunId.
  if (session.currentRunId) {
    const status = await getRunStatus(session.currentRunId);
    if (status && !isFinalRunStatus(status)) {
      return { runId: session.currentRunId, triggered: false };
    }
  }

  // 2. Validate config + trigger upfront.
  const config = SessionTriggerConfigSchema.parse(session.triggerConfig);
  const triggered = await triggerSessionRun({
    session,
    config,
    environment,
    payloadOverrides,
  });

  // 3. Try to claim the slot atomically.
  const claim = await prisma.session.updateMany({
    where: {
      id: session.id,
      currentRunVersion: session.currentRunVersion,
    },
    data: {
      currentRunId: triggered.id,
      currentRunVersion: { increment: 1 },
    },
  });

  if (claim.count === 1) {
    // Won. Audit the SessionRun. Best-effort — failure here doesn't
    // invalidate the live run, just leaves a missing audit row.
    prisma.sessionRun
      .create({
        data: { sessionId: session.id, runId: triggered.id, reason },
      })
      .catch((error) => {
        logger.warn("Failed to record SessionRun audit row", {
          sessionId: session.id,
          runId: triggered.id,
          reason,
          error,
        });
      });

    return { runId: triggered.id, triggered: true };
  }

  // 4. Lost the race. Cancel our triggered run; reuse the winner's.
  cancelLostRaceRun(triggered.id, environment).catch((error) => {
    logger.warn("Failed to cancel lost-race session run", {
      sessionId: session.id,
      runId: triggered.id,
      error,
    });
  });

  const fresh = await $replica.session.findFirst({
    where: { id: session.id },
    select: {
      id: true,
      taskIdentifier: true,
      triggerConfig: true,
      currentRunId: true,
      currentRunVersion: true,
    },
  });

  if (!fresh) {
    // Session vanished mid-flight. Surface as an error — caller decides
    // whether to 404 or retry.
    throw new SessionRunManagerError(`Session ${session.id} not found after lost claim race`);
  }

  if (fresh.currentRunId) {
    const status = await getRunStatus(fresh.currentRunId);
    if (status && !isFinalRunStatus(status)) {
      return { runId: fresh.currentRunId, triggered: false };
    }
  }

  // Pathological: winner's run already terminal. Recurse with the fresh
  // version. Bounded by run-engine progress — if every triggered run
  // dies instantly we'll loop, but that's a deeper bug worth surfacing.
  return ensureRunForSession({
    session: fresh,
    environment,
    reason,
    payloadOverrides,
  });
}

/**
 * Trigger a single run for a session. Builds `TriggerTaskRequestBody`
 * by shallow-merging `payloadOverrides` over `config.basePayload` and
 * threading `config`'s machine/queue/tags through the trigger options.
 */
async function triggerSessionRun(params: {
  session: Pick<Session, "id" | "taskIdentifier">;
  config: SessionTriggerConfig;
  environment: AuthenticatedEnvironment;
  payloadOverrides?: Record<string, unknown>;
}): Promise<{ id: string; friendlyId: string }> {
  const { session, config, environment, payloadOverrides } = params;

  const payload = {
    ...config.basePayload,
    ...(config.idleTimeoutInSeconds !== undefined
      ? { idleTimeoutInSeconds: config.idleTimeoutInSeconds }
      : {}),
    ...(payloadOverrides ?? {}),
  };

  const body = {
    payload,
    context: {},
    options: {
      ...(config.machine ? { machine: config.machine as never } : {}),
      ...(config.queue ? { queue: { name: config.queue } } : {}),
      ...(config.tags ? { tags: config.tags } : {}),
      ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    },
  };

  const service = new TriggerTaskService();
  const result = await service.call(session.taskIdentifier, environment, body, {
    triggerSource: "session",
    triggerAction: "trigger",
  });

  if (!result) {
    throw new SessionRunManagerError(
      `TriggerTaskService returned no result for taskIdentifier=${session.taskIdentifier}`
    );
  }

  return { id: result.run.id, friendlyId: result.run.friendlyId };
}

type SwapSessionRunParams = {
  session: Pick<
    Session,
    "id" | "taskIdentifier" | "triggerConfig" | "currentRunId" | "currentRunVersion"
  >;
  /**
   * The run requesting the swap. Optimistic claim requires
   * `Session.currentRunId === callingRunId` so the swap can't clobber
   * a run triggered out-of-band (e.g. a parallel `.in/append` probe
   * that already replaced the dead run).
   */
  callingRunId: string;
  environment: AuthenticatedEnvironment;
  reason: EnsureRunReason;
  payloadOverrides?: Record<string, unknown>;
};

export type SwapSessionRunResult = {
  /** runId of the newly-triggered run that has taken over the session. */
  runId: string;
  /**
   * False when the swap was preempted (currentRunId is no longer the
   * calling run). The caller should treat this as "someone else
   * already moved on" — exit cleanly without expecting to drive the
   * next run.
   */
  swapped: boolean;
};

/**
 * Force-swap the session to a freshly-triggered run, regardless of
 * whether the current run is alive. Called by `end-and-continue` when
 * the running agent wants a clean handoff (typically version upgrade).
 *
 * Differs from `ensureRunForSession`: never reuses the current run.
 * The optimistic claim is keyed on `currentRunId === callingRunId`, so
 * a parallel append-time probe that already swapped to a different
 * run wins the race and `swapped: false` is surfaced.
 */
export async function swapSessionRun(
  params: SwapSessionRunParams
): Promise<SwapSessionRunResult> {
  const { session, callingRunId, environment, reason, payloadOverrides } = params;

  const config = SessionTriggerConfigSchema.parse(session.triggerConfig);
  const triggered = await triggerSessionRun({
    session,
    config,
    environment,
    payloadOverrides,
  });

  const claim = await prisma.session.updateMany({
    where: {
      id: session.id,
      currentRunId: callingRunId,
      currentRunVersion: session.currentRunVersion,
    },
    data: {
      currentRunId: triggered.id,
      currentRunVersion: { increment: 1 },
    },
  });

  if (claim.count === 1) {
    prisma.sessionRun
      .create({
        data: { sessionId: session.id, runId: triggered.id, reason },
      })
      .catch((error) => {
        logger.warn("Failed to record SessionRun audit row", {
          sessionId: session.id,
          runId: triggered.id,
          reason,
          error,
        });
      });
    return { runId: triggered.id, swapped: true };
  }

  // Lost the race — someone else already swapped to a new run. Cancel
  // ours, surface the existing winner.
  cancelLostRaceRun(triggered.id, environment).catch((error) => {
    logger.warn("Failed to cancel preempted swap run", {
      sessionId: session.id,
      runId: triggered.id,
      error,
    });
  });

  const fresh = await $replica.session.findFirst({
    where: { id: session.id },
    select: { currentRunId: true },
  });

  return {
    runId: fresh?.currentRunId ?? callingRunId,
    swapped: false,
  };
}

async function getRunStatus(runId: string): Promise<TaskRunStatus | null> {
  // Use the read replica — this is a hot-path probe and stale-by-ms is
  // fine. The append handler re-checks if it ends up reusing the runId.
  const row = await $replica.taskRun.findFirst({
    where: { id: runId },
    select: { status: true },
  });
  return row?.status ?? null;
}

async function cancelLostRaceRun(
  runId: string,
  environment: AuthenticatedEnvironment
): Promise<void> {
  const service = new CancelTaskRunService();
  // Resolve to a TaskRun reference — CancelTaskRunService takes the run
  // object, not the id. Read from the replica; the actual cancellation
  // write happens inside the service.
  const run = await $replica.taskRun.findFirst({ where: { id: runId } });
  if (!run) return;
  await service.call(run, { reason: "Lost session-run claim race" });
}

export class SessionRunManagerError extends Error {
  readonly name = "SessionRunManagerError";
}

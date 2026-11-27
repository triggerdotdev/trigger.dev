import type { Prisma, Session, TaskRunStatus } from "@trigger.dev/database";
import type { SessionRunHandover } from "@trigger.dev/core/v3";
import {
  SessionTriggerConfig as SessionTriggerConfigZod,
  TaskRunError,
  tryCatch,
} from "@trigger.dev/core/v3";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { prisma, $replica, $transaction } from "~/db.server";
import { runStore } from "~/v3/runStore.server";
import {
  findCurrentDeployment,
  findCurrentDeploymentVersion,
} from "~/v3/models/workerDeployment.server";
import { engine } from "~/v3/runEngine.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { startActiveSpan } from "~/v3/tracer.server";
import { CancelTaskRunService, type CancelableTaskRun } from "~/v3/services/cancelTaskRun.server";
import { TriggerTaskService } from "~/v3/services/triggerTask.server";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { externalDeploymentCacheInstance } from "~/services/externalDeploymentCacheInstance.server";
import { resolveExternalDeployment } from "~/v3/services/resolveExternalDeployment.server";
import { S2RealtimeStreams, type SessionOutTail } from "./s2realtimeStreams.server";
import { canonicalSessionAddressingKey } from "./sessions.server";
import { turnContinuationVersion } from "./turnHandoverState";
import {
  determineRealtimeStreamsVersion,
  getRealtimeStreamInstance,
} from "./v1StreamsGlobal.server";
import {
  basePayloadHasMessage,
  isVersionBelowSessionVersionFloor,
  sessionVersionFloorFor,
  shouldSupersedeLiveRun,
  waitpointBlockingRunCheck,
  type LiveRunFloorChecks,
  type SessionVersionFloor,
} from "./sessionVersionFloor.server";
import { listSessionStreamWaitpoints } from "~/services/sessionStreamWaitpointCache.server";
import {
  parseSupersededRunCancelReason,
  type SessionRunReason,
  SKEW_THRESHOLD_RUN_REASON,
  supersededRunCancelReason,
} from "~/utils/sessionMove";

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

/**
 * Why a session run started. `skew-threshold` replaces a live run below the environment's skew
 * protection threshold; `ensureRunForSession` sets it itself.
 */
export type EnsureRunReason = SessionRunReason;

/**
 * Hard cap on how many times `ensureRunForSession` will recurse on the
 * pathological "we lost the claim race AND the winner's run was already
 * terminal" path. In practice progress through the run engine bounds
 * this, but a misconfigured task that crashes before it can be dequeued
 * could otherwise loop without limit. After this many attempts we
 * surface `SessionRunManagerError` so the caller can 5xx instead of
 * blowing the stack.
 */
const ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS = 3;

type EnsureRunForSessionParams = {
  /**
   * Session row to operate on. Caller is responsible for the env match —
   * we don't re-check `runtimeEnvironmentId` against `environment.id`.
   *
   * `friendlyId` is used to pre-populate `payload.sessionId` on the new
   * run so the agent's `chat.agent` boot path can attach to `session.in/.out`
   * without a control-plane round-trip. `currentRunId` is also forwarded
   * as `payload.previousRunId` (with `continuation: true`) when the prior
   * run is dead, so the agent's boot gate triggers snapshot.read + replay
   * instead of treating the run as a fresh chat.
   */
  session: Pick<
    Session,
    | "id"
    | "friendlyId"
    | "externalId"
    | "taskIdentifier"
    | "triggerConfig"
    | "currentRunId"
    | "currentRunVersion"
    | "streamBasinName"
  >;
  environment: AuthenticatedEnvironment;
  reason: EnsureRunReason;
  /**
   * Shallow-merged on top of `triggerConfig.basePayload`. Runtime fields
   * only — caller-controlled data that varies per trigger (`trigger:
   * "preload"` vs `"trigger"`, etc).
   */
  payloadOverrides?: Record<string, unknown>;
  /**
   * Read the current run's status from the writer instead of the replica. For a caller that has
   * just seen that run end (or must not act on a replica that has not caught up with its end):
   * a stale "still alive" answer would hand back a run that is already gone.
   */
  probeOnWriter?: boolean;
  /**
   * The first `.in` seq the run started here is meant to answer, for a caller that already has
   * messages on `.in` it is starting the run for (`RunAnnotations.sessionInFirstSeq`). Leave it
   * unset when the run is started before its messages are appended.
   */
  sessionInFirstSeq?: number;
  /**
   * @internal Recursion-guard counter for the lost-claim-race retry path.
   * Public callers should leave this unset; the function recurses with
   * an incremented value on the pathological "winner's run was already
   * terminal" branch and throws once it exceeds
   * {@link ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS}.
   */
  _attempt?: number;
};

export type EnsureRunResult = {
  runId: string;
  /** True if this call triggered a fresh run; false if it reused an alive existing one. */
  triggered: boolean;
  /** The run is parked waiting for a deployment carrying the session's external deployment id. */
  pendingVersion: boolean;
};

/**
 * Idempotently make sure the session has a live run.
 *
 * Algorithm:
 *   1. If `currentRunId` is set, probe its status. Alive → return as-is,
 *      unless the environment has a version floor, the run is below it, the
 *      current deployment is at or above it and the run is idle: then it is
 *      superseded by the new run. Cancelled by a move → another append is
 *      moving the session: wait for its claim and use its run.
 *   2. Trigger a new run upfront (cheap to cancel if we lose the race).
 *      A superseded run is cancelled now, before the new run becomes visible
 *      through the claim. If that cancel fails, cancel the new run and keep
 *      the superseded one. If the superseded run was executing, wait (up to
 *      about 5 s) for its process to stop, so it can't read the next append.
 *   3. Atomic claim via `updateMany` keyed on `currentRunVersion`.
 *      - Won (the SessionRun row is written in the same transaction): return
 *        new runId.
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
  const {
    session,
    environment,
    reason,
    payloadOverrides,
    probeOnWriter,
    sessionInFirstSeq,
    _attempt = 1,
  } = params;

  if (_attempt > ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS) {
    throw new SessionRunManagerError(
      `ensureRunForSession exceeded ${ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS} attempts for session ${session.id} — every triggered run reached a terminal state before claim could resolve`
    );
  }

  const floor = sessionVersionFloorFor(environment, session.taskIdentifier);

  // 1. Probe currentRunId.
  let priorRunFriendlyId: string | undefined;
  // A move in flight that never claimed its run: cancelled once this call's own claim wins.
  let unclaimedSuccessor: string | undefined;
  let superseded:
    | {
        runId: string;
        taskVersion: string | null;
        status: TaskRunStatus;
        floor: SessionVersionFloor;
        movedToVersion: string;
      }
    | undefined;
  if (session.currentRunId) {
    let probe = probeOnWriter ? null : await getCurrentRunProbe(session.currentRunId);
    if (!probe) {
      // Replica miss on a row we just observed via `currentRunId` — the
      // run was likely triggered moments ago and hasn't replicated yet.
      // Re-probe the writer BEFORE deciding liveness: treating a lagging
      // replica as "row vanished" double-triggers the session (a fast
      // first append after session create races the replica apply delay
      // and spawns a second live run consuming the same `.in`).
      probe = await runStore.findRun(
        { id: session.currentRunId },
        { select: CURRENT_RUN_PROBE_SELECT },
        prisma
      );
    }
    // Under a floor a cancelled current run can be another append's move in flight: it cancelled
    // this run and claims its own once the run has stopped. Triggering here would skip that wait
    // and race the claim, so wait for the claim and use it.
    if (floor && probe?.status === "CANCELED") {
      const wait = await waitForMoveInFlight({ id: session.id, runId: session.currentRunId });
      if (wait?.session) {
        return ensureRunForSession({
          session: wait.session,
          environment,
          reason,
          payloadOverrides,
          _attempt: _attempt + 1,
        });
      }
      unclaimedSuccessor = wait?.unclaimedSuccessor;
    }
    if (probe && !isFinalRunStatus(probe.status)) {
      const moveTarget = floor
        ? await liveRunMoveTarget(session, environment, floor, {
            id: session.currentRunId,
            taskVersion: probe.taskVersion,
            createdAt: probe.createdAt,
            startedWithMessage: basePayloadHasMessage(session.triggerConfig),
          })
        : undefined;
      if (!floor || !moveTarget) {
        return {
          runId: session.currentRunId,
          triggered: false,
          pendingVersion: isPendingVersionStatus(probe.status),
        };
      }
      superseded = {
        runId: session.currentRunId,
        taskVersion: probe.taskVersion,
        status: probe.status,
        floor,
        movedToVersion: moveTarget.currentVersion,
      };
    }
    // The prior run is gone (probe null on the writer too), final, or below
    // the version floor and about to be cancelled. In each case it won't
    // consume new appends — but the session may still hold conversation state on
    // `session.out` and an S3 snapshot keyed on `session.friendlyId`.
    // Forward the prior run's public-form id (friendlyId — same shape as
    // `ctx.run.id`) to the agent as `previousRunId` so its boot gate flips
    // `couldHavePriorState` and replays the persisted state instead of
    // treating this as a fresh chat. See `chat.agent`'s boot orchestration
    // in `packages/trigger-sdk/src/v3/ai.ts`.
    priorRunFriendlyId = probe?.friendlyId ?? session.currentRunId;
  }

  // 2. Validate config + trigger upfront. Continuation overrides
  // (`continuation`, `previousRunId`) are derived from session state above
  // and merged AFTER caller-supplied overrides — caller can't accidentally
  // unset them on a session that has had a prior run, but can still
  // override `trigger`/`metadata` etc. `sessionId` is always set so the
  // agent doesn't need a control-plane round-trip to look up the session
  // friendlyId from `payload.chatId`.
  // Continuation overrides strip the basePayload's first-run-only fields
  // so a continuation run doesn't inherit a stale boot payload. The Session
  // row's `triggerConfig.basePayload` is captured at create-time and used
  // verbatim for every Run we trigger; if the customer included `message`
  // / `messages` / `trigger: "submit-message"` to make the FIRST run boot
  // straight into a first turn (via `chat.createStartSessionAction`), those
  // values stick around and get replayed on every continuation. With
  // `continuation: true` and `message`/`messages` cleared, the SDK boot
  // path enters its continuation-wait branch and waits for the next
  // session.in record before running a turn.
  const continuationOverrides: Record<string, unknown> = {
    sessionId: session.friendlyId,
    ...(priorRunFriendlyId !== undefined
      ? {
          continuation: true,
          previousRunId: priorRunFriendlyId,
          // Clear sticky boot-payload fields so the new run waits for the
          // next session.in record instead of re-processing whatever was
          // in the original `createStartSessionAction({ basePayload })`.
          message: undefined,
          messages: undefined,
          trigger: undefined,
        }
      : {}),
  };
  const mergedPayloadOverrides: Record<string, unknown> = {
    ...(payloadOverrides ?? {}),
    ...continuationOverrides,
  };

  const config = SessionTriggerConfigSchema.parse(session.triggerConfig);
  const triggered = await triggerSessionRun({
    session,
    config,
    environment,
    payloadOverrides: mergedPayloadOverrides,
    sessionInFirstSeq,
    // A session's first run is anchored at `.in` seq 0 without reading the tail. `currentRunId`
    // is only set by a claim and never cleared, so null means no run has ever been claimed, and
    // that run's agent boots with no `.out` cursor and reads `.in` from seq 0 (on a first boot
    // nothing on `.in` counts as applied): every message on `.in`, including one that landed
    // before it was triggered, is its to answer. So 0 is exact, not an approximation. It also
    // skips an S2 read that, on a basin that creates streams on read, would create `.in`. A run
    // started for messages already on `.in` (`sessionInFirstSeq`) still reads it, so its anchor
    // stays above its first seq as `RunAnnotations` requires. Every other trigger (a current run,
    // the lost-race recursion below, a swap, a revive, a continuation) reads the tail as before.
    // Derived from `session` so the recursion re-derives it from the fresh row.
    sessionInSeq: session.currentRunId || sessionInFirstSeq !== undefined ? undefined : 0,
  });

  if (superseded) {
    const [cancelError, cancelResult] = await tryCatch(
      cancelSessionRun(
        superseded.runId,
        supersededRunCancelReason({
          // A pin at or above the threshold is kept, so the replacement can run below current.
          movedToVersion: triggered.taskVersion ?? superseded.movedToVersion,
          newRunFriendlyId: triggered.friendlyId,
          taskIdentifier: superseded.floor.taskIdentifier,
        })
      )
    );
    if (cancelError && !(await isRunFinalOnWriter(superseded.runId))) {
      logger.warn("Failed to cancel a session run below the session version floor; keeping it", {
        sessionId: session.id,
        runId: superseded.runId,
        error: cancelError,
      });
      cancelUnclaimedRun({
        runId: triggered.id,
        sessionId: session.id,
        reason: "Superseded run could not be cancelled",
        failureMessage: "Failed to cancel an unused session run",
      });
      return {
        runId: superseded.runId,
        triggered: false,
        pendingVersion: isPendingVersionStatus(superseded.status),
      };
    }
    // Two appends can both see the old run live and both cancel it. The first cancel's reason
    // names the run the notice links to, so only that append claims; the other drops its run and
    // waits for that claim.
    const move = await readMoveOnWriter(superseded.runId);
    if (move && move.newRunFriendlyId !== triggered.friendlyId) {
      cancelUnclaimedRun({
        runId: triggered.id,
        sessionId: session.id,
        reason: "Another append is moving this session",
        failureMessage: "Failed to cancel an unused session run",
      });
      return ensureRunForSession({
        session,
        environment,
        reason,
        payloadOverrides,
        probeOnWriter: true,
        _attempt: _attempt + 1,
      });
    }
    // A warm run reads `.in` in its own process. The cancel only asked its worker to stop, so
    // without this the message the caller appends next could still start a turn in the old run.
    // A cancel that ended the run and then threw may not have reached the worker: wait the same way
    // (at once when the run had already stopped).
    if (cancelResult?.pendingCancel || cancelError) {
      await waitForSupersededRunToStop({ runId: superseded.runId, sessionId: session.id });
    }
  }

  // 3. Try to claim the slot atomically, recording the SessionRun row with it.
  const won = await claimSessionRun({
    where: {
      id: session.id,
      currentRunVersion: session.currentRunVersion,
      // Closedness is decided on the writer, not on the replica the caller
      // resolved from. An append that raced a close reads a stale open row and
      // gets this far; without this the closed conversation would get a brand
      // new run.
      closedAt: null,
    },
    data: {
      currentRunId: triggered.id,
      currentRunVersion: { increment: 1 },
    },
    sessionId: session.id,
    triggered,
    reason: superseded ? SKEW_THRESHOLD_RUN_REASON : reason,
  });

  if (won) {
    // Our claim moved `currentRunVersion` past the one that move read, so its run can't claim now.
    if (unclaimedSuccessor) cancelUnclaimedSuccessor(session.id, unclaimedSuccessor);
    if (superseded) {
      logger.info("Superseded a live run below the session version floor", {
        sessionId: session.id,
        runId: superseded.runId,
        taskVersion: superseded.taskVersion,
        minVersion: superseded.floor.minVersion,
        thresholdTask: superseded.floor.taskIdentifier,
        newRunId: triggered.id,
        // True: the new run waits for a deployment that has its task, so the chat is silent.
        pendingVersion: isPendingVersionStatus(triggered.status),
      });
    }
    return {
      runId: triggered.id,
      triggered: true,
      pendingVersion: isPendingVersionStatus(triggered.status),
    };
  }

  // 4. Lost the race. Cancel our triggered run; reuse the winner's.
  cancelUnclaimedRun({
    runId: triggered.id,
    sessionId: session.id,
    failureMessage: "Failed to cancel lost-race session run",
  });

  // Read-after-write: the winner just wrote `currentRunId` /
  // `currentRunVersion` on the writer. Reading from `$replica` could
  // return pre-race state and cause us to recurse with the same stale
  // version, losing the next claim, until we exhaust max attempts.
  const fresh = await prisma.session.findFirst({
    where: { id: session.id },
    select: ENSURE_SESSION_SELECT,
  });

  if (!fresh) {
    // Session vanished mid-flight. Surface as an error — caller decides
    // whether to 404 or retry.
    throw new SessionRunManagerError(`Session ${session.id} not found after lost claim race`);
  }

  if (fresh.closedAt) {
    // The claim lost to a close, not to another writer. Recursing would
    // trigger and cancel a run per attempt and then throw; there is nothing to
    // ensure for a conversation that is over.
    throw new SessionClosedError(`Session ${session.id} is closed`);
  }

  if (fresh.currentRunId) {
    // Same read-after-write reason as the `fresh` reload above: the winner
    // just wrote `currentRunId` on the writer, so probe the writer too —
    // the replica may not have the run row yet, and a missed probe forces
    // another trigger+recurse until `ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS`.
    const probe = await runStore.findRun(
      { id: fresh.currentRunId },
      { select: { status: true, friendlyId: true } },
      prisma
    );
    if (probe && !isFinalRunStatus(probe.status)) {
      return {
        runId: fresh.currentRunId,
        triggered: false,
        pendingVersion: isPendingVersionStatus(probe.status),
      };
    }
  }

  // Pathological: winner's run already terminal. Recurse with the fresh
  // version. Bounded by `ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS` so a task
  // that always crashes before being dequeued surfaces as an error
  // instead of a stack overflow.
  return ensureRunForSession({
    session: fresh,
    environment,
    reason,
    payloadOverrides,
    sessionInFirstSeq,
    _attempt: _attempt + 1,
  });
}

/**
 * The first `.in` seq a run started for messages already on `.in` will answer
 * (`RunAnnotations.sessionInFirstSeq`). One rule for every such start (a revive after an append,
 * the completion check's continuation): the new run boots from the cursor of the last
 * `turn-complete` on `.out` and answers everything after it, so its first seq is that cursor plus
 * one, whoever wrote the turn. When `.out` does not end on a turn-complete that carries an `.in`
 * cursor there is no boot cursor to read, and it is the earliest message known to be unread
 * (`earliestKnownSeq`: the appended seq on a revive, the first unread seq on a continuation).
 *
 * The cursor can sit above `earliestKnownSeq` only when the turn already consumed that message, so
 * the result is at or below every message the new run answers and above everything an earlier run
 * consumed.
 */
export function firstSeqForNewRun(
  outTail: SessionOutTail,
  earliestKnownSeq: number | undefined
): number | undefined {
  if (
    outTail.kind === "record" &&
    outTail.control === "turn-complete" &&
    outTail.inEventId !== undefined
  ) {
    return outTail.inEventId + 1;
  }
  return earliestKnownSeq;
}

/**
 * `firstSeqForNewRun` for a revive, which has not read `.out` yet. One `.out` tail peek, bounded by
 * the S2 client's timeout. A peek that fails falls back to the appended seq: the run still starts.
 */
async function firstSeqForRevive(
  session: Pick<Session, "friendlyId" | "externalId" | "streamBasinName">,
  environment: AuthenticatedEnvironment,
  appendedSeq: number
): Promise<number> {
  const [error, firstSeq] = await tryCatch(
    (async () => {
      const streams = getRealtimeStreamInstance(environment, "v2", { session });
      if (!(streams instanceof S2RealtimeStreams)) return appendedSeq;
      const outTail = await streams.peekSessionOutTail(
        canonicalSessionAddressingKey(session, session.friendlyId)
      );
      return firstSeqForNewRun(outTail, appendedSeq) ?? appendedSeq;
    })()
  );
  if (error) {
    logger.warn("Failed to read the session .out tail to revive its run", {
      sessionId: session.friendlyId,
      error,
    });
    return appendedSeq;
  }
  return firstSeq;
}

/**
 * Call after every `.in` append that followed an `ensureRunForSession` (one home for the rule).
 *
 * The ensure probed the run before the record landed, so a run that ended in between was reused as
 * if it were alive and will never read the record. Look at that run again now that the record is
 * durable, on the writer: a run still alive here ends after the record landed, so the completion
 * check (`continueSessionIfInputUnread`) reads it; a run already ended is replaced now, started for
 * the messages already on `.in` (`firstSeqForNewRun`, with the appended seq as the earliest known
 * one). A run that was cancelled is left alone: a cancel is a decision to stop (the run-end
 * handlers skip it for the same reason), so a cancel that lands before the record does not start a
 * run that answers it; the next append starts one, as it does after any ended run. Costs one
 * primary-key read per append that reused a run, and, only when it replaces a run, one `.out` tail
 * peek. Never throws: on a failure the append stands and the completion check or the next append
 * revives the session.
 *
 * The race that remains: appends are concurrent, so the one that wins the revive claim may not be
 * the first to land. The boot cursor, not the winner's own seq, keeps the first seq at or below an
 * earlier unread message; when the `.out` peek fails the first seq falls back to the appended seq,
 * which can sit above one, and an earlier run's turn-complete is then judged by `sessionInSeq` alone
 * if that run fails (the same fallback as a run started with no first seq).
 */
export async function reviveReusedRunIfEnded(params: {
  session: EnsureRunForSessionParams["session"];
  environment: AuthenticatedEnvironment;
  reason: EnsureRunReason;
  ensured: EnsureRunResult;
  /**
   * The seq the append wrote the record at; undefined when it wrote none (a lost claim) or got no
   * seq back. The run is then started without a first seq: the winner's own revive carries it.
   */
  appendedSeq?: number;
}): Promise<EnsureRunResult> {
  const { session, environment, reason, ensured, appendedSeq } = params;
  if (ensured.triggered) return ensured;

  const [error, revived] = await tryCatch(
    (async () => {
      const probe = await runStore.findRun(
        { id: ensured.runId },
        { select: { status: true } },
        prisma
      );
      if (!probe || !isFinalRunStatus(probe.status) || probe.status === "CANCELED") {
        return undefined;
      }
      return ensureRunForSession({
        session: { ...session, currentRunId: ensured.runId },
        environment,
        reason,
        probeOnWriter: true,
        sessionInFirstSeq:
          appendedSeq !== undefined
            ? await firstSeqForRevive(session, environment, appendedSeq)
            : undefined,
      });
    })()
  );
  if (error) {
    logger.error("Failed to re-check the run an append reused", {
      sessionId: session.id,
      runId: ensured.runId,
      error,
    });
    return ensured;
  }
  return revived ?? ensured;
}

/** Both version pins are forwarded; `TriggerTaskService` decides which governs. */
export function buildSessionRunOptions(config: SessionTriggerConfig) {
  return {
    ...(config.machine ? { machine: config.machine as never } : {}),
    ...(config.queue ? { queue: { name: config.queue } } : {}),
    ...(config.concurrency ? { concurrency: config.concurrency } : {}),
    ...(config.concurrencyKey !== undefined ? { concurrencyKey: config.concurrencyKey } : {}),
    ...(config.tags ? { tags: config.tags } : {}),
    ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}),
    ...(config.maxDuration !== undefined ? { maxDuration: config.maxDuration } : {}),
    ...(config.lockToVersion ? { lockToVersion: config.lockToVersion } : {}),
    ...(config.externalDeploymentId ? { externalDeploymentId: config.externalDeploymentId } : {}),
    ...(config.region ? { region: config.region } : {}),
    ...(config.ttl !== undefined ? { ttl: config.ttl } : {}),
  };
}

function isPendingVersionStatus(status: TaskRunStatus): boolean {
  return status === "PENDING_VERSION";
}

/**
 * The session's `.in` tail seq (the next seq), recorded on the run as `sessionInSeq` so the
 * run-end check can tell which messages arrived after it started. Read before the run is created:
 * a message appended between the read and the run's creation counts as the new run's, which is
 * right, since the run boots from the cursor and reads it. Undefined when the streams are not S2
 * or the tail cannot be read: the check then falls back to timestamps, and the trigger goes on.
 *
 * Cost: one S2 tail read per session-run trigger that has no known tail (a session's first run
 * passes its own, see `ensureRunForSession`), bounded by the S2 client's timeout; no query.
 */
async function readSessionInSeqForTrigger(
  session: Pick<Session, "friendlyId" | "externalId" | "streamBasinName">,
  environment: AuthenticatedEnvironment
): Promise<number | undefined> {
  const [error, seq] = await tryCatch(
    startActiveSpan("readSessionInSeqForTrigger()", async (span) => {
      const streams = getRealtimeStreamInstance(environment, "v2", { session });
      if (!(streams instanceof S2RealtimeStreams)) return undefined;
      const tailSeq = await streams.readSessionInTailSeq(
        canonicalSessionAddressingKey(session, session.friendlyId)
      );
      if (tailSeq !== undefined) span.setAttribute("session.in_seq", tailSeq);
      return tailSeq;
    })
  );
  if (error) {
    logger.warn("Failed to read the session .in tail before triggering its run", {
      sessionId: session.friendlyId,
      error,
    });
    return undefined;
  }
  return seq;
}

/**
 * Trigger a single run for a session. Builds `TriggerTaskRequestBody`
 * by shallow-merging `payloadOverrides` over `config.basePayload` and
 * threading `config`'s machine/queue/tags through the trigger options.
 *
 * A session's own channels are always v2, so the run is stamped to match
 * rather than inheriting the `realtimeStreamsVersion` column default. Without
 * this, run-scoped `streams.*` calls inside a session run resolve to v1 while
 * the session it belongs to is on v2. `determineRealtimeStreamsVersion`
 * degrades to v1 where v2 streams are not configured.
 *
 * The run records the `.in` tail as `sessionInSeq`: the caller's, when it already knows it (a
 * session's first run, anchored at 0), else the tail read just before the trigger. And, when
 * the caller is starting it for messages already on `.in` (a revive after an append, a continuation
 * for unread input), the first seq it was started to answer (`sessionInFirstSeq`, below the tail).
 * Each field has one job, told on `RunAnnotations`.
 */
async function triggerSessionRun(params: {
  session: Pick<Session, "id" | "friendlyId" | "externalId" | "taskIdentifier" | "streamBasinName">;
  config: SessionTriggerConfig;
  environment: AuthenticatedEnvironment;
  payloadOverrides?: Record<string, unknown>;
  /** Lock this run to a version, over the session's pins and the floor (a handed-over turn). */
  lockToVersion?: string;
  sessionInFirstSeq?: number;
  /** The `.in` tail when it is already known; read when unset. */
  sessionInSeq?: number;
}): Promise<{
  id: string;
  friendlyId: string;
  status: TaskRunStatus;
  createdAt?: Date;
  /** Set at trigger only for a run locked to a version (a pin at or above any threshold). */
  taskVersion?: string;
}> {
  const { session, environment, payloadOverrides } = params;
  const pinned = await sessionPinsInEffect(params.config, environment, session.taskIdentifier);
  const config = params.lockToVersion
    ? { ...pinned, lockToVersion: params.lockToVersion, externalDeploymentId: undefined }
    : pinned;

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
    options: buildSessionRunOptions(config),
  };

  const { sessionInFirstSeq } = params;
  const sessionInSeq =
    params.sessionInSeq ?? (await readSessionInSeqForTrigger(session, environment));

  const service = new TriggerTaskService();
  const result = await service.call(session.taskIdentifier, environment, body, {
    triggerSource: "session",
    triggerAction: "trigger",
    sessionId: session.friendlyId,
    ...(sessionInSeq !== undefined ? { sessionInSeq } : {}),
    ...(sessionInFirstSeq !== undefined ? { sessionInFirstSeq } : {}),
    realtimeStreamsVersion: determineRealtimeStreamsVersion(
      "v2",
      environment.organization.streamBasinName
    ),
  });

  if (!result) {
    throw new SessionRunManagerError(
      `TriggerTaskService returned no result for taskIdentifier=${session.taskIdentifier}`
    );
  }

  return {
    id: result.run.id,
    friendlyId: result.run.friendlyId,
    status: result.run.status,
    // A mollified trigger returns a synthetic run: no row yet, so no createdAt.
    createdAt: result.isMollified ? undefined : result.run.createdAt,
    taskVersion: result.run.taskVersion ?? undefined,
  };
}

type SwapSessionRunParams = {
  /**
   * Session row to swap. `friendlyId` is forwarded as `payload.sessionId`
   * on the new run so the agent attaches to `session.in/.out` without a
   * control-plane round-trip (same convention as
   * {@link EnsureRunForSessionParams}).
   */
  session: Pick<
    Session,
    | "id"
    | "friendlyId"
    | "externalId"
    | "taskIdentifier"
    | "triggerConfig"
    | "currentRunId"
    | "currentRunVersion"
    | "streamBasinName"
  >;
  /**
   * The run requesting the swap. Optimistic claim requires
   * `Session.currentRunId === callingRunId` so the swap can't clobber
   * a run triggered out-of-band (e.g. a parallel `.in/append` probe
   * that already replaced the dead run).
   *
   * Also forwarded as `payload.previousRunId` on the new run alongside
   * `continuation: true` — every swap is a continuation by construction
   * (`chat.requestUpgrade` / `chat.endRun` deliberately hand off prior
   * conversation state to a new run), so the agent's boot gate flips
   * `couldHavePriorState` and replays the snapshot + session.out tail.
   */
  callingRunId: string;
  environment: AuthenticatedEnvironment;
  reason: EnsureRunReason;
  payloadOverrides?: Record<string, unknown>;
  /**
   * Only read when `reason` is `"upgrade"` (`chat.requestUpgrade`): a string re-pins the session,
   * absent clears the pin.
   */
  externalDeploymentId?: string | null;
  /** The calling run stopped partway through a reply: recorded on the new run's SessionRun row. */
  handover?: SessionRunHandover;
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
  /** See {@link EnsureRunResult.pendingVersion}. */
  pendingVersion: boolean;
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
export async function swapSessionRun(params: SwapSessionRunParams): Promise<SwapSessionRunResult> {
  const { callingRunId, environment, payloadOverrides } = params;

  // The route reads the session on the replica, which can be a claim behind (a move or an upgrade
  // just before) with an older config. Read the row on the writer before triggering, so the run
  // is built from the stored config and the claim uses the current version: retrying after a lost
  // claim would mean a second continuation while the first may already be booting. One primary-key
  // read per handoff.
  const onWriter = await prisma.session.findFirst({
    where: { id: params.session.id },
    select: { currentRunVersion: true, triggerConfig: true },
  });
  const session = onWriter ? { ...params.session, ...onWriter } : params.session;

  // A handed-over turn continues only on a deployment whose SDK can continue it. Any token that can
  // write the session can ask for a `skew-threshold` move, which locks past the session's
  // `lockToVersion` pin: it counts only while a threshold is above the calling run.
  const handover =
    params.reason === SKEW_THRESHOLD_RUN_REASON
      ? await handoverContinuation(environment, callingRunId, session.taskIdentifier)
      : undefined;
  if (params.reason === SKEW_THRESHOLD_RUN_REASON && !handover) {
    logger.warn("A skew-threshold handover with no threshold above the run: treated as manual", {
      sessionId: session.id,
      callingRunId,
    });
  }
  const reason: EnsureRunReason =
    params.reason === SKEW_THRESHOLD_RUN_REASON && !handover ? "manual" : params.reason;
  // The handover is recorded only for a move it explains, and names the threshold the server found,
  // not the caller's.
  const recordedHandover: SessionRunHandover | undefined = !params.handover
    ? undefined
    : handover
      ? { ...params.handover, thresholdVersion: handover.thresholdVersion }
      : reason === "upgrade"
        ? { afterSteps: params.handover.afterSteps, messageId: params.handover.messageId }
        : undefined;

  // `callingRunId` is the internal cuid (`Session.currentRunId` stores
  // cuid; the route handler resolves the wire's friendlyId before passing
  // it here). The agent's `previousRunId` is customer-visible and must
  // match the public `run_*` form exposed via `ctx.run.id` — resolve
  // before forwarding.
  const callingRunFriendlyId = await resolveRunFriendlyId(callingRunId);

  // Continuation overrides — unconditionally set on swap. Unlike
  // `ensureRunForSession`, there's no dead-run-detection branch here:
  // every swap is a deliberate handoff from `callingRunId` (which owned
  // prior conversation state) to a fresh run. Merged AFTER caller-supplied
  // overrides so a caller can't accidentally unset them.
  //
  // Sticky boot-payload fields (`message` / `messages` / `trigger`) are
  // cleared here for the same reason as in `ensureRunForSession`: the
  // Session's basePayload is captured at create-time and replays on every
  // continuation if not stripped. See the comment in `ensureRunForSession`.
  const mergedPayloadOverrides: Record<string, unknown> = {
    ...(payloadOverrides ?? {}),
    sessionId: session.friendlyId,
    continuation: true,
    previousRunId: callingRunFriendlyId,
    message: undefined,
    messages: undefined,
    trigger: undefined,
  };

  const storedConfig = SessionTriggerConfigSchema.parse(session.triggerConfig);

  // The `chat.requestUpgrade` pin is persisted in the claim below, not applied to this run alone: the next
  // continuation re-reads the stored config. `lockToVersion` is deliberately untouched.
  const config =
    reason === "upgrade"
      ? { ...storedConfig, externalDeploymentId: params.externalDeploymentId ?? undefined }
      : storedConfig;

  // Any other move of a handed-over turn (`chat.requestUpgrade()` mid-turn, a threshold cleared
  // before the swap) gets the same receiver check as the threshold's.
  const lockedVersion = handover
    ? handover.lockToVersion
    : params.handover
      ? await handoverReceiverVersion(environment, config, session.taskIdentifier, callingRunId)
      : undefined;

  const triggered = await triggerSessionRun({
    session,
    config,
    environment,
    payloadOverrides: mergedPayloadOverrides,
    lockToVersion: lockedVersion,
  });

  const claim = (currentRunVersion: number) =>
    claimSessionRun({
      where: {
        id: session.id,
        currentRunId: callingRunId,
        currentRunVersion,
        // Same writer-side guard as the ensure path: a close can commit between
        // the route's replica read and this update, and a handoff must not start
        // a continuation on a conversation that is over.
        closedAt: null,
      },
      data: {
        currentRunId: triggered.id,
        currentRunVersion: { increment: 1 },
        ...(reason === "upgrade" ? { triggerConfig: config as Prisma.InputJsonValue } : {}),
      },
      sessionId: session.id,
      triggered,
      reason,
      handover: recordedHandover,
    });

  let won = await claim(session.currentRunVersion);
  if (!won) {
    // Back-to-back moves: this run can ask to move on before the swap that started it commits, so
    // it read the version below its own. If the writer now names this run, with the config the
    // successor was built from, claim again at that version: still one successor.
    const owner = await prisma.session
      .findFirst({
        where: { id: session.id },
        select: {
          currentRunId: true,
          currentRunVersion: true,
          triggerConfig: true,
          closedAt: true,
        },
      })
      .catch((error: unknown) => {
        // The claim definitely missed: don't leave the successor running beside the owner.
        cancelUnclaimedRun({
          runId: triggered.id,
          sessionId: session.id,
          failureMessage: "Failed to cancel preempted swap run",
        });
        throw error;
      });
    if (
      owner?.currentRunId === callingRunId &&
      !owner.closedAt &&
      owner.currentRunVersion !== session.currentRunVersion &&
      isDeepStrictEqual(owner.triggerConfig, session.triggerConfig)
    ) {
      won = await claim(owner.currentRunVersion);
    }
  }

  if (reason === SKEW_THRESHOLD_RUN_REASON) {
    logger.info("Handed a turn over to a new run", {
      sessionId: session.id,
      callingRunId,
      newRunId: triggered.id,
      swapped: won,
      lockedVersion,
      afterSteps: recordedHandover?.afterSteps,
      thresholdVersion: recordedHandover?.thresholdVersion,
      pendingVersion: isPendingVersionStatus(triggered.status),
    });
  }

  if (won) {
    return {
      runId: triggered.id,
      swapped: true,
      pendingVersion: isPendingVersionStatus(triggered.status),
    };
  }

  // Lost the race — someone else already swapped to a new run. Cancel
  // ours, surface the existing winner.
  cancelUnclaimedRun({
    runId: triggered.id,
    sessionId: session.id,
    failureMessage: "Failed to cancel preempted swap run",
  });

  // Read-after-write: the winner's swap was just committed on the
  // writer. A replica read could return the pre-swap `currentRunId`
  // (often `callingRunId` itself), which would tell the caller it is
  // still the canonical run when in fact a different run has taken
  // over.
  const fresh = await prisma.session.findFirst({
    where: { id: session.id },
    select: { currentRunId: true, closedAt: true },
  });

  if (fresh?.closedAt) {
    // The claim lost to a close, not to another swap. The run triggered above
    // is already being cancelled; reporting a winner here would tell the caller
    // a closed session has a live run.
    throw new SessionClosedError(`Session ${session.id} is closed`);
  }

  // Mirror `ensureRunForSession`'s "session vanished" branch: if we
  // can't find the row (or it has no current run) on the writer right
  // after losing the race, surface as an error rather than handing back
  // `callingRunId` with `swapped: false` — that would tell the caller
  // it's still the canonical run when in fact we don't know who is.
  if (!fresh?.currentRunId) {
    throw new SessionRunManagerError(
      `Session ${session.id} has no currentRunId after preempted swap`
    );
  }

  const winner = await runStore.findRun(
    { id: fresh.currentRunId },
    { select: { status: true } },
    prisma
  );

  return {
    runId: fresh.currentRunId,
    swapped: false,
    pendingVersion: winner ? isPendingVersionStatus(winner.status) : false,
  };
}

type TriggeredSessionRun = Awaited<ReturnType<typeof triggerSessionRun>>;

/**
 * Claims the session for `triggered` and records its SessionRun row in one transaction, so a
 * claimed run is always linked to its session. Returns false when the claim was lost. If the
 * transaction fails and the run's row isn't on the writer, the triggered run is cancelled and
 * the error is rethrown.
 */
async function claimSessionRun(params: {
  where: Prisma.SessionWhereInput;
  data: Prisma.SessionUpdateManyMutationInput;
  sessionId: string;
  triggered: TriggeredSessionRun;
  reason: EnsureRunReason;
  handover?: SessionRunHandover;
}): Promise<boolean> {
  const { where, data, sessionId, triggered, reason, handover } = params;

  const [error, won] = await tryCatch(
    $transaction(prisma, "sessionRunManager.claimSessionRun", async (tx) => {
      const claim = await tx.session.updateMany({ where, data });
      if (claim.count !== 1) return false;

      // Mollified runs have no createdAt yet; the column default (insert time) stands in.
      await tx.sessionRun.create({
        data: {
          sessionId,
          runId: triggered.id,
          reason,
          triggeredAt: triggered.createdAt,
          ...(handover ? { handover } : {}),
        },
      });
      return true;
    })
  );

  if (!error) return won === true;

  // The commit may have landed with its reply lost. This session's row for the run only exists if
  // this transaction committed. If that can't be read either, cancel: a cancelled claimed run
  // is replaced by the next append, while a leaked run competes for the session's input.
  const [readError, row] = await tryCatch(
    prisma.sessionRun.findFirst({ where: { runId: triggered.id, sessionId }, select: { id: true } })
  );
  if (readError) {
    logger.warn("Could not check whether a failed session run claim committed", {
      sessionId,
      runId: triggered.id,
      error: readError,
    });
  } else if (row) {
    logger.warn("Session run claim committed despite a transaction error", {
      sessionId,
      runId: triggered.id,
      error,
    });
    return true;
  }

  cancelUnclaimedRun({
    runId: triggered.id,
    sessionId,
    failureMessage: "Failed to cancel unclaimed session run",
  });
  throw error;
}

const CANCELABLE_RUN_SELECT = {
  id: true,
  engine: true,
  status: true,
  friendlyId: true,
  taskEventStore: true,
  createdAt: true,
  completedAt: true,
} as const satisfies Record<keyof CancelableTaskRun, true>;

/** What `ensureRunForSession` needs of a session re-read mid-flight, plus `closedAt`. */
const ENSURE_SESSION_SELECT = {
  id: true,
  friendlyId: true,
  externalId: true,
  taskIdentifier: true,
  triggerConfig: true,
  currentRunId: true,
  currentRunVersion: true,
  streamBasinName: true,
  closedAt: true,
} as const satisfies Prisma.SessionSelect;

const CURRENT_RUN_PROBE_SELECT = {
  status: true,
  friendlyId: true,
  taskVersion: true,
  createdAt: true,
} as const;

async function getCurrentRunProbe(runId: string): Promise<{
  status: TaskRunStatus;
  friendlyId: string;
  taskVersion: string | null;
  createdAt: Date;
} | null> {
  // Use the read replica — hot-path probe, stale-by-ms is fine. The dangerous
  // stale shape (looks-vanished → double-trigger) is closed by the writer re-probe
  // in ensureRunForSession; a stale-non-final reuse self-heals via the durable S2
  // stream + next-append re-probe (there is no append-handler re-check).
  // `friendlyId` is fetched alongside `status` so the dead-run-detection
  // branch in `ensureRunForSession` can forward the public-form id as
  // `payload.previousRunId` without a second read. `Session.currentRunId`
  // stores the internal cuid; the agent's wire / customer hooks expose
  // the friendlyId via `ctx.run.id`, so consistency matters. `taskVersion`
  // and `createdAt` let the version floor decide whether a live run is
  // superseded (below the floor, and idle long enough) without another read.
  const row = await runStore.findRun({ id: runId }, { select: CURRENT_RUN_PROBE_SELECT }, $replica);
  return row ?? null;
}

/**
 * Where a live run below the session's version floor moves to: the current deployment's version
 * when the run should be replaced, undefined when it keeps the session.
 */
async function liveRunMoveTarget(
  session: Pick<Session, "id" | "friendlyId" | "externalId" | "streamBasinName">,
  environment: AuthenticatedEnvironment,
  floor: SessionVersionFloor,
  run: { id: string; taskVersion: string | null; createdAt: Date; startedWithMessage: boolean }
): Promise<{ currentVersion: string } | undefined> {
  const decision = await shouldSupersedeLiveRun(
    floor,
    run,
    session.externalId ?? session.friendlyId,
    liveRunFloorChecks(session, environment)
  );
  if (decision.supersede) return { currentVersion: decision.currentVersion };

  if (decision.reason === "current-below-floor") {
    logger.warn(
      "Current deployment is below the session version floor; reusing the live run. Promote a deployment at or above minVersion, or lower the floor",
      {
        sessionId: session.id,
        runId: run.id,
        environmentId: environment.id,
        currentVersion: decision.currentVersion,
        minVersion: floor.minVersion,
      }
    );
  } else if (decision.reason === "busy") {
    // The commonest answer to "why didn't this session move": a reply in progress, inside the
    // grace after one, or S2 unreadable (an S2 warn for the stream sits next to this line).
    logger.info("Kept a run below the skew protection threshold: busy", {
      sessionId: session.id,
      runId: run.id,
      environmentId: environment.id,
      taskVersion: run.taskVersion,
      minVersion: floor.minVersion,
      thresholdTask: floor.taskIdentifier,
    });
  } else if (decision.reason === "check-failed") {
    logger.warn("Idle check failed; reusing the run below the version floor", {
      sessionId: session.id,
      runId: run.id,
      environmentId: environment.id,
      error: decision.error.message,
    });
  }
  return undefined;
}

function liveRunFloorChecks(
  session: Pick<Session, "streamBasinName">,
  environment: AuthenticatedEnvironment
): LiveRunFloorChecks {
  return {
    currentDeploymentVersion() {
      return findCurrentDeploymentVersion(environment.id, $replica);
    },
    streams() {
      const realtimeStream = getRealtimeStreamInstance(environment, "v2", { session });
      return realtimeStream instanceof S2RealtimeStreams ? realtimeStream : undefined;
    },
    waiters: {
      listSessionInWaitpoints: (addressingKey) =>
        listSessionStreamWaitpoints(environment.id, addressingKey, "in"),
      isWaitpointBlockingRun: waitpointBlockingRunCheck(environment, { engine, runStore }),
    },
  };
}

/**
 * The session's pins as the server applies them when it starts a run: a pin below the task's
 * skew protection threshold is ignored. Returns `config` itself when nothing is dropped.
 */
export async function sessionPinsInEffect(
  config: SessionTriggerConfig,
  environment: AuthenticatedEnvironment,
  taskIdentifier: string
): Promise<SessionTriggerConfig> {
  const floor = sessionVersionFloorFor(environment, taskIdentifier);
  return floor ? dropPinsBelowFloor(config, environment, floor) : config;
}

async function dropPinsBelowFloor(
  config: SessionTriggerConfig,
  environment: AuthenticatedEnvironment,
  floor: SessionVersionFloor
): Promise<SessionTriggerConfig> {
  let result = config;
  if (result.lockToVersion) {
    if (!isVersionBelowSessionVersionFloor(result.lockToVersion, floor)) return result;
    result = { ...result, lockToVersion: undefined };
  }

  if (result.externalDeploymentId) {
    const resolution = await resolveExternalDeployment({
      prisma: $replica,
      environmentId: environment.id,
      externalDeploymentId: result.externalDeploymentId,
      cache: externalDeploymentCacheInstance,
    });
    if (
      resolution.outcome === "park" ||
      isVersionBelowSessionVersionFloor(resolution.worker.version, floor)
    ) {
      result = { ...result, externalDeploymentId: undefined };
    }
  }

  return result;
}

async function isRunFinalOnWriter(runId: string): Promise<boolean> {
  const [error, run] = await tryCatch(
    runStore.findRun({ id: runId }, { select: { status: true } }, prisma)
  );
  return !error && run !== null && isFinalRunStatus(run.status);
}

/**
 * The version a handed-over turn continues on (see {@link turnContinuationVersion}), or undefined
 * when no threshold is above the calling run. Reads on the writer: the current deployment and the
 * run, then whether the current deployment has the task. A threshold over an agent the current
 * deployment no longer has would lock the continuation to a version that can't start it; the turn
 * continues on the handing-over run's version instead.
 */
async function handoverContinuation(
  environment: AuthenticatedEnvironment,
  callingRunId: string,
  taskIdentifier: string
): Promise<{ lockToVersion: string | undefined; thresholdVersion: string } | undefined> {
  const floor = sessionVersionFloorFor(environment, taskIdentifier);
  if (!floor) return undefined;
  const [current, callingRun] = await Promise.all([
    findCurrentDeployment(environment.id, prisma),
    runStore.findRun({ id: callingRunId }, { select: { taskVersion: true } }, prisma),
  ]);
  if (
    !callingRun?.taskVersion ||
    !isVersionBelowSessionVersionFloor(callingRun.taskVersion, floor)
  ) {
    return undefined;
  }
  const currentTask = current?.workerId
    ? await prisma.backgroundWorkerTask.findFirst({
        where: { workerId: current.workerId, slug: taskIdentifier },
        select: { config: true },
      })
    : null;
  return {
    lockToVersion: turnContinuationVersion(
      current && currentTask
        ? { version: current.version, taskConfig: currentTask.config }
        : undefined,
      callingRun.taskVersion
    ),
    thresholdVersion: floor.minVersion,
  };
}

/**
 * The version a turn handed over without a threshold above the calling run continues on: the
 * deployment the session's pins pick when its task can continue a turn, otherwise the calling
 * run's version (see {@link turnContinuationVersion}). A pin to a deployment that isn't ready
 * reads as one that can't.
 */
async function handoverReceiverVersion(
  environment: AuthenticatedEnvironment,
  config: SessionTriggerConfig,
  taskIdentifier: string,
  callingRunId: string
): Promise<string | undefined> {
  const pins = await sessionPinsInEffect(config, environment, taskIdentifier);
  const [target, callingRun] = await Promise.all([
    handoverTargetWorker(environment, pins),
    runStore.findRun({ id: callingRunId }, { select: { taskVersion: true } }, prisma),
  ]);
  const targetTask = target?.workerId
    ? await prisma.backgroundWorkerTask.findFirst({
        where: { workerId: target.workerId, slug: taskIdentifier },
        select: { config: true },
      })
    : null;
  return turnContinuationVersion(
    target && targetTask ? { version: target.version, taskConfig: targetTask.config } : undefined,
    callingRun?.taskVersion
  );
}

/** The worker a run started with these pins lands on, as triggerSessionRun picks it. */
async function handoverTargetWorker(
  environment: AuthenticatedEnvironment,
  pins: SessionTriggerConfig
): Promise<{ version: string; workerId: string | null } | undefined> {
  if (pins.lockToVersion) {
    const worker = await prisma.backgroundWorker.findFirst({
      where: { runtimeEnvironmentId: environment.id, version: pins.lockToVersion },
      select: { id: true, version: true },
    });
    return worker ? { version: worker.version, workerId: worker.id } : undefined;
  }
  if (pins.externalDeploymentId) {
    const resolution = await resolveExternalDeployment({
      prisma,
      environmentId: environment.id,
      externalDeploymentId: pins.externalDeploymentId,
      cache: externalDeploymentCacheInstance,
    });
    return resolution.outcome === "park"
      ? undefined
      : { version: resolution.worker.version, workerId: resolution.worker.workerId };
  }
  return findCurrentDeployment(environment.id, prisma);
}

/**
 * Resolve a TaskRun cuid to its friendlyId. Used by `swapSessionRun` to
 * forward the calling run's public-form id as `payload.previousRunId` on
 * the new run. Falls back to the cuid on lookup miss so the swap doesn't
 * fail just because the read replica hasn't caught up — the agent only
 * uses `previousRunId` for customer-visible bookkeeping (e.g.
 * `runs.retrieve(previousRunId)`), so a stale-but-non-null value is
 * acceptable degraded behavior.
 */
async function resolveRunFriendlyId(runId: string): Promise<string> {
  const row = await runStore.findRun({ id: runId }, { select: { friendlyId: true } }, $replica);
  return row?.friendlyId ?? runId;
}

/** Fire-and-forget cancel of a run that never became the session's current run. */
function cancelUnclaimedRun(params: {
  runId: string;
  sessionId: string;
  failureMessage: string;
  reason?: string;
}): void {
  const { runId, sessionId, failureMessage, reason = "Lost session-run claim race" } = params;
  cancelSessionRun(runId, reason).catch((error) => {
    logger.warn(failureMessage, { sessionId, runId, error });
  });
}

async function cancelSessionRun(
  runId: string,
  reason: string
): Promise<{ pendingCancel?: boolean } | undefined> {
  // Read on the writer: a lost-race run was just triggered there, and a
  // `$replica` miss would silently no-op the cancel and leak an orphan run
  // that no session is going to claim.
  const run = await runStore.findRun({ id: runId }, { select: CANCELABLE_RUN_SELECT }, prisma);
  if (!run) return undefined;
  return new CancelTaskRunService().call(run, { reason });
}

/** How long a move waits for a cancelled warm run to stop before appending anyway. */
const SUPERSEDED_RUN_STOP_TIMEOUT_MS = 5_000;
const SUPERSEDED_RUN_STOP_POLL_MS = [25, 50, 100, 200, 250];

/**
 * Wait until a run cancelled mid-execution has stopped: its worker killed the process and reported
 * the attempt. The cancel itself leaves `completedAt` empty; that report sets it, together with
 * the run's FINISHED execution snapshot, so it is only there once the process is gone. Polled on
 * the replica with backoff, one primary-key read of that column per poll (a few per move); a
 * cancel ack can be handled by any webapp instance, so there is no local event to wait on. On
 * timeout the caller continues as before the wait existed. Every wait is logged with how long it
 * took and whether it hit the cap.
 */
async function waitForSupersededRunToStop(params: {
  runId: string;
  sessionId: string;
}): Promise<void> {
  const { runId, sessionId } = params;
  const startedAt = performance.now();
  const deadline = startedAt + SUPERSEDED_RUN_STOP_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    const pollMs =
      SUPERSEDED_RUN_STOP_POLL_MS[Math.min(attempt, SUPERSEDED_RUN_STOP_POLL_MS.length - 1)];
    await sleep(Math.min(pollMs, remainingMs));

    const [error, run] = await tryCatch(
      runStore.findRun({ id: runId }, { select: { completedAt: true } }, $replica)
    );
    // A miss is a replica that doesn't have the row yet, not a run that is gone.
    if (error || !run) continue;
    if (run.completedAt) {
      logSupersededRunStopWait({ sessionId, runId, startedAt, hitCap: false });
      return;
    }
  }

  logSupersededRunStopWait({ sessionId, runId, startedAt, hitCap: true });
}

/**
 * One line per wait, so the cap can be chosen from real cancel ack times. At the cap the caller
 * goes ahead while the old run may still be able to read the next message, hence the warn.
 */
function logSupersededRunStopWait(params: {
  sessionId: string;
  runId: string;
  startedAt: number;
  hitCap: boolean;
}): void {
  const { sessionId, runId, startedAt, hitCap } = params;
  const fields = {
    sessionId,
    runId,
    waitedMs: Math.round(performance.now() - startedAt),
    hitCap,
    capMs: SUPERSEDED_RUN_STOP_TIMEOUT_MS,
  };
  if (hitCap) {
    logger.warn("Waited for a superseded session run to stop", fields);
  } else {
    logger.info("Waited for a superseded session run to stop", fields);
  }
}

/**
 * How long a second append waits for the append that started a move to claim its run. That append
 * claims at the end of its own wait (at most {@link SUPERSEDED_RUN_STOP_TIMEOUT_MS} after its
 * cancel), so past this it isn't going to.
 */
const MOVE_IN_FLIGHT_CLAIM_TIMEOUT_MS = SUPERSEDED_RUN_STOP_TIMEOUT_MS + 500;

/**
 * The session's current run is cancelled. If its cancel reason says a move replaced it, another
 * append is waiting for it to stop and will then claim the run it triggered (a session only keeps
 * pointing at such a run until that claim): wait for the claim and return the session as it then
 * is. Returns undefined when the run wasn't cancelled by a move, or the claim didn't come in
 * time; the caller then carries on as for any dead run.
 */
async function waitForMoveInFlight(params: {
  id: string;
  runId: string;
}): Promise<
  | { session: Prisma.SessionGetPayload<{ select: typeof ENSURE_SESSION_SELECT }> }
  | { session?: undefined; unclaimedSuccessor: string }
  | undefined
> {
  const { id, runId } = params;

  const move = await readMoveOnWriter(runId);
  if (!move) return undefined;

  const startedAt = performance.now();
  const deadline = startedAt + MOVE_IN_FLIGHT_CLAIM_TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    // The replica is enough: this waits for a change, and lag only makes it a little later.
    const [pollError, fresh] = await tryCatch(
      $replica.session.findFirst({ where: { id }, select: ENSURE_SESSION_SELECT })
    );
    if (!pollError && fresh) {
      if (fresh.closedAt) throw new SessionClosedError(`Session ${id} is closed`);
      if (fresh.currentRunId !== runId) return { session: fresh };
    }

    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) break;
    const pollMs =
      SUPERSEDED_RUN_STOP_POLL_MS[Math.min(attempt, SUPERSEDED_RUN_STOP_POLL_MS.length - 1)];
    await sleep(Math.min(pollMs, remainingMs));
  }

  // The replica can still be behind at the deadline: decide on the writer.
  const [writerError, onWriter] = await tryCatch(
    prisma.session.findFirst({ where: { id }, select: ENSURE_SESSION_SELECT })
  );
  if (!writerError && onWriter) {
    if (onWriter.closedAt) throw new SessionClosedError(`Session ${id} is closed`);
    if (onWriter.currentRunId !== runId) return { session: onWriter };
  }

  logger.warn("A session move in flight didn't claim its run in time; starting a new run", {
    sessionId: id,
    runId,
    successorRunId: move.newRunFriendlyId,
    waitedMs: Math.round(performance.now() - startedAt),
  });
  // The append that started the move most likely went away before claiming (a webapp restart
  // during its stop wait). Its run would wait on `.in` beside the caller's and answer too, but it
  // can still claim until the caller's claim wins, so the caller cancels it only then.
  return { unclaimedSuccessor: move.newRunFriendlyId };
}

/** The move recorded in a run's cancel reason, read on the writer (the run was cancelled moments ago). */
async function readMoveOnWriter(runId: string) {
  const [readError, run] = await tryCatch(
    runStore.findRun({ id: runId }, { select: { error: true } }, prisma)
  );
  if (readError || !run) return undefined;
  const error = TaskRunError.safeParse(run.error);
  return error.success && error.data.type === "STRING_ERROR"
    ? parseSupersededRunCancelReason(error.data.raw)
    : undefined;
}

/** Cancel the run of a move that never claimed it, once the caller's own claim has won. */
function cancelUnclaimedSuccessor(sessionId: string, friendlyId: string): void {
  void (async () => {
    const [findError, successor] = await tryCatch(
      runStore.findRun({ friendlyId }, { select: { id: true } }, prisma)
    );
    if (findError || !successor) return;
    cancelUnclaimedRun({
      runId: successor.id,
      sessionId,
      reason: "The session move that started this run never claimed it",
      failureMessage: "Failed to cancel an unclaimed session move run",
    });
  })();
}

class SessionRunManagerError extends Error {
  readonly name: string = "SessionRunManagerError";
}

/** The run claim lost to a close: there is no run to ensure for this session. */
export class SessionClosedError extends SessionRunManagerError {
  readonly name: string = "SessionClosedError";
}

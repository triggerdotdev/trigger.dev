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
    | "taskIdentifier"
    | "triggerConfig"
    | "currentRunId"
    | "currentRunVersion"
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
  const { session, environment, reason, payloadOverrides, _attempt = 1 } = params;

  if (_attempt > ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS) {
    throw new SessionRunManagerError(
      `ensureRunForSession exceeded ${ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS} attempts for session ${session.id} — every triggered run reached a terminal state before claim could resolve`
    );
  }

  // 1. Probe currentRunId.
  let priorDeadRunFriendlyId: string | undefined;
  if (session.currentRunId) {
    const probe = await getRunStatusAndFriendlyId(session.currentRunId);
    if (probe && !isFinalRunStatus(probe.status)) {
      return { runId: session.currentRunId, triggered: false };
    }
    // Either the row vanished (probe null) or its status is final. Either
    // way the prior run isn't going to consume new appends — but the
    // session may still hold conversation state on `session.out` and an
    // S3 snapshot keyed on `session.friendlyId`. Forward the prior run's
    // public-form id (friendlyId — same shape as `ctx.run.id`) to the
    // agent as `previousRunId` so its boot gate flips
    // `couldHavePriorState` and replays the persisted state instead of
    // treating this as a fresh chat. See `chat.agent`'s boot orchestration
    // in `packages/trigger-sdk/src/v3/ai.ts`.
    if (probe?.friendlyId) {
      priorDeadRunFriendlyId = probe.friendlyId;
    } else {
      // Replica miss on a row we just observed via `currentRunId`. Retry
      // on the writer so the customer's `runs.retrieve(previousRunId)`
      // gets the public `run_*` form rather than the internal cuid.
      const writerProbe = await prisma.taskRun.findFirst({
        where: { id: session.currentRunId },
        select: { friendlyId: true },
      });
      priorDeadRunFriendlyId = writerProbe?.friendlyId ?? session.currentRunId;
    }
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
    ...(priorDeadRunFriendlyId !== undefined
      ? {
          continuation: true,
          previousRunId: priorDeadRunFriendlyId,
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

  // Read-after-write: the winner just wrote `currentRunId` /
  // `currentRunVersion` on the writer. Reading from `$replica` could
  // return pre-race state and cause us to recurse with the same stale
  // version, losing the next claim, until we exhaust max attempts.
  const fresh = await prisma.session.findFirst({
    where: { id: session.id },
    select: {
      id: true,
      friendlyId: true,
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
    // Same read-after-write reason as the `fresh` reload above: the winner
    // just wrote `currentRunId` on the writer, so probe the writer too —
    // the replica may not have the run row yet, and a missed probe forces
    // another trigger+recurse until `ENSURE_RUN_FOR_SESSION_MAX_ATTEMPTS`.
    const probe = await prisma.taskRun.findFirst({
      where: { id: fresh.currentRunId },
      select: { status: true, friendlyId: true },
    });
    if (probe && !isFinalRunStatus(probe.status)) {
      return { runId: fresh.currentRunId, triggered: false };
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
    _attempt: _attempt + 1,
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
      ...(config.maxDuration !== undefined ? { maxDuration: config.maxDuration } : {}),
      ...(config.lockToVersion ? { lockToVersion: config.lockToVersion } : {}),
      ...(config.region ? { region: config.region } : {}),
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
    | "taskIdentifier"
    | "triggerConfig"
    | "currentRunId"
    | "currentRunVersion"
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

  const config = SessionTriggerConfigSchema.parse(session.triggerConfig);
  const triggered = await triggerSessionRun({
    session,
    config,
    environment,
    payloadOverrides: mergedPayloadOverrides,
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

  // Read-after-write: the winner's swap was just committed on the
  // writer. A replica read could return the pre-swap `currentRunId`
  // (often `callingRunId` itself), which would tell the caller it is
  // still the canonical run when in fact a different run has taken
  // over.
  const fresh = await prisma.session.findFirst({
    where: { id: session.id },
    select: { currentRunId: true },
  });

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

  return {
    runId: fresh.currentRunId,
    swapped: false,
  };
}

async function getRunStatusAndFriendlyId(
  runId: string
): Promise<{ status: TaskRunStatus; friendlyId: string } | null> {
  // Use the read replica — this is a hot-path probe and stale-by-ms is
  // fine. The append handler re-checks if it ends up reusing the runId.
  // `friendlyId` is fetched alongside `status` so the dead-run-detection
  // branch in `ensureRunForSession` can forward the public-form id as
  // `payload.previousRunId` without a second read. `Session.currentRunId`
  // stores the internal cuid; the agent's wire / customer hooks expose
  // the friendlyId via `ctx.run.id`, so consistency matters.
  const row = await $replica.taskRun.findFirst({
    where: { id: runId },
    select: { status: true, friendlyId: true },
  });
  return row ?? null;
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
  const row = await $replica.taskRun.findFirst({
    where: { id: runId },
    select: { friendlyId: true },
  });
  return row?.friendlyId ?? runId;
}

async function cancelLostRaceRun(
  runId: string,
  environment: AuthenticatedEnvironment
): Promise<void> {
  const service = new CancelTaskRunService();
  // Read-after-write: the run was just triggered on the writer, so go
  // through `prisma`. A `$replica` miss here would silently no-op the
  // cancel and leak an orphan run that no session is going to claim.
  const run = await prisma.taskRun.findFirst({ where: { id: runId } });
  if (!run) return;
  await service.call(run, { reason: "Lost session-run claim race" });
}

export class SessionRunManagerError extends Error {
  readonly name = "SessionRunManagerError";
}

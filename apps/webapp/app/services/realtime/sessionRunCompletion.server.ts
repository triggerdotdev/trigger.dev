import { RunAnnotations, tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { S2RealtimeStreams } from "./s2realtimeStreams.server";
import { ensureRunForSession, firstSeqForNewRun } from "./sessionRunManager.server";
import { canonicalSessionAddressingKey } from "./sessions.server";
import { getRealtimeStreamInstance } from "./v1StreamsGlobal.server";

export const SESSION_RUN_COMPLETION_JOB = "sessionRun.continueIfInputUnread" as const;

/** How many times the queue runs the job before it gives up (its retry setting on the worker). */
export const SESSION_RUN_COMPLETION_MAX_ATTEMPTS = 8;

export const SessionRunCompletionPayloadSchema = z.object({
  /** The run that ended: `TaskRun.id`. */
  runId: z.string(),
  /** `TaskRun.createdAt` of that run, ISO 8601. */
  runCreatedAt: z.string(),
  environmentId: z.string(),
  /**
   * The run's recorded `RunAnnotations.sessionInSeq` and `sessionInFirstSeq`.
   * Optional: a job queued before runs recorded them has none.
   */
  sessionInSeq: z.number().int().nonnegative().optional(),
  sessionInFirstSeq: z.number().int().nonnegative().optional(),
  /**
   * How the run ended. Optional: a job queued by older code has none, and is judged as a
   * succeeded run is.
   */
  outcome: z.enum(["succeeded", "failed"]).optional(),
});

/** How the run that ended finished: `runSucceeded` or `runFailed`. */
export type SessionRunOutcome = NonNullable<
  z.infer<typeof SessionRunCompletionPayloadSchema>["outcome"]
>;

export type SessionContinuationOutcome =
  | "continued"
  | "already-running"
  | "nothing-unread"
  /** A failed run that died inside a turn: left to the user, see `continueSessionIfInputUnread`. */
  | "failed-mid-turn"
  | "not-a-session-run"
  /**
   * `.out` holds only S2 command records, so the run's last turn cannot be read: a final answer,
   * not retried, nothing continued. See `hasUnreadSessionMessage`.
   */
  | "out-commands-only"
  | "unreadable";

/** Records read per page when looking for an unread message, and how many pages at most. */
const UNREAD_SCAN_PAGE_SIZE = 100;
const UNREAD_SCAN_MAX_PAGES = 3;

type SessionInputStreams = Pick<
  S2RealtimeStreams,
  "peekSessionOutTail" | "readSessionInTailSeq" | "readSessionStreamRecords"
>;

/**
 * Is there a message on `.in` that the run which just ended never read?
 *
 * A run that FAILED and did not end on a turn-complete of its own died mid-turn (partial chunks on
 * `.out` after the message it was answering) or at boot (nothing of its own on `.out`): it answers
 * "failed-mid-turn" without looking at `.in`, so nothing re-answers the message it died on. See
 * `continueSessionIfInputUnread` for why. A failed run that did end on its own turn-complete is
 * judged like any other, below.
 *
 * When the run wrote a turn of its own (the `turn-complete` ending `.out` is its own, see below),
 * that record carries the `.in` cursor it committed (`session-in-event-id`): everything at or below
 * it was handled, a message past it was queued or arrived unseen. The header is older than the
 * consumed-sequence one, so this works for an SDK that predates it.
 *
 * A run that wrote no turn (a preloaded run or a continuation run that idled out waiting, or one
 * that died before its first turn), or whose last turn carries no cursor (a turn started from the
 * payload before the agent read `.in`, or one that ended while `.in` seq 0 was still queued),
 * published nothing to trust, and an older cursor belongs to a previous run. What it can be held to
 * is what arrived after it started: a message at or after the `.in` tail read when it was triggered
 * (`sessionInSeq`). A message below it is the previous run's to answer, so at most one run is ever
 * started per message, whatever the run answers: a continuation started for an unread message that
 * ends without a turn of its own does not find that message again. Seqs are exact: S2's clock and
 * ours need not agree, which a timestamp comparison would have to assume. The run's messages sit at
 * the end of `.in`, so it reads forward from the anchor, at most `UNREAD_SCAN_MAX_PAGES` pages, and
 * an anchor at or past the tail answers without a read.
 *
 * A run that has no `sessionInSeq` (triggered before runs recorded it, or the tail could not be read
 * then) falls back to the timestamps: a message stored at or after the run was created. Records
 * are timestamped on arrival and timestamps on one stream do not go backwards, so that run's
 * messages sit at the tail: it reads the end of `.in` newest page first and stops at the first
 * record older than the run.
 *
 * Whose a `turn-complete` is: with a first seq (`sessionInFirstSeq`, else `sessionInSeq`: they are
 * the same for a run started before its messages landed), the run's own iff it carries an `.in`
 * cursor at or past it (the turn consumed a message the run was started for, or one that arrived
 * after); a cursorless one says nothing about whose it is, so it is not taken as the run's. Without
 * either, the run's own iff stored at or after the run was created.
 *
 * A `.out` that holds only S2 command records answers "out-commands-only", without looking at
 * `.in`: the turn this run wrote can no longer be read, so nothing says what it answered.
 *
 * Cost: a run with a cursor, or an anchor, reads forward from it, at most `UNREAD_SCAN_MAX_PAGES`
 * pages. A run with neither reads at most that many pages of `UNREAD_SCAN_PAGE_SIZE` records from
 * the tail, and the usual answer on a long session (nothing new) is one read of one page. There a
 * record is parsed only once its timestamp is known to be at or after the run's start.
 */
async function hasUnreadSessionMessage(
  streams: SessionInputStreams,
  addressingKey: string,
  run: { createdAt: Date; sessionInSeq?: number; sessionInFirstSeq?: number },
  outcome: SessionRunOutcome | undefined
): Promise<
  | { status: "unread"; firstSeq: number | undefined }
  | { status: "nothing-unread" | "failed-mid-turn" | "out-commands-only" | "unreadable" }
> {
  const outTail = await streams.peekSessionOutTail(addressingKey);
  if (outTail.kind === "unknown") return { status: "unreadable" };
  // `.out` was read and holds no record to go on (a trim deleted the turn-complete or every
  // record, or the agent trimmed several times after it): the run's last turn is gone, and retrying cannot bring
  // it back. Not "empty": that would scan `.in` from the run's start and could start a run that
  // re-answers messages whose turn-complete was deleted. A message the run never read may go
  // unanswered until the user's next one, which starts a run; a duplicate reply is the worse miss.
  if (outTail.kind === "commands-only") return { status: "out-commands-only" };

  const ownershipSeq = run.sessionInFirstSeq ?? run.sessionInSeq;
  const wroteOwnTurn =
    outTail.kind === "record" &&
    outTail.control === "turn-complete" &&
    (ownershipSeq !== undefined
      ? outTail.inEventId !== undefined && outTail.inEventId >= ownershipSeq
      : outTail.timestamp >= run.createdAt.getTime());

  if (outcome === "failed" && !wroteOwnTurn) return { status: "failed-mid-turn" };

  // The next seq on `.in`.
  const inTail = await streams.readSessionInTailSeq(addressingKey);
  if (inTail === undefined) return { status: "unreadable" };

  // A boundary without an `.in` cursor (a turn started from the payload before the agent read
  // `.in`, or one that ended while `.in` seq 0 was still queued) says nothing about what was read:
  // judge it by what arrived while the run lived, as for a run that wrote no turn. Scanning from
  // seq 0 would count earlier runs' answered messages.
  let scan: UnreadScan;
  if (!wroteOwnTurn || outTail.inEventId === undefined) {
    scan =
      run.sessionInSeq !== undefined
        ? await hasUnreadMessageFrom(streams, addressingKey, inTail, run.sessionInSeq)
        : await hasUnreadMessageSince(streams, addressingKey, inTail, run.createdAt.getTime());
  } else {
    scan = await hasUnreadMessageFrom(streams, addressingKey, inTail, outTail.inEventId + 1);
  }
  return scan.status === "unread"
    ? { status: "unread", firstSeq: firstSeqForNewRun(outTail, scan.firstSeq) }
    : scan;
}

type UnreadScan =
  | { status: "unread"; firstSeq: number | undefined }
  | { status: "nothing-unread" | "unreadable" };

/**
 * A turn message on `.in` at seq `firstSeq` or later, read forward from `firstSeq` in at most
 * `UNREAD_SCAN_MAX_PAGES` pages. `readSessionStreamRecords` returns records after the seq it is
 * given, so the read starts after `firstSeq - 1`. Nothing sits at or past `inTail`, the next seq.
 */
async function hasUnreadMessageFrom(
  streams: SessionInputStreams,
  addressingKey: string,
  inTail: number,
  firstSeq: number
): Promise<UnreadScan> {
  if (inTail <= firstSeq) return { status: "nothing-unread" };

  let cursor = firstSeq - 1;
  for (let page = 0; page < UNREAD_SCAN_MAX_PAGES; page++) {
    const records = await streams.readSessionStreamRecords(
      addressingKey,
      "in",
      cursor,
      undefined,
      UNREAD_SCAN_PAGE_SIZE
    );
    if (records.length === 0) return { status: "nothing-unread" };
    const first = records.find((record) => isTurnMessage(record.data));
    if (first) return { status: "unread", firstSeq: first.seqNum };
    cursor = records[records.length - 1]!.seqNum;
    if (cursor + 1 >= inTail) break;
  }
  return { status: "nothing-unread" };
}

/**
 * A turn message stored on `.in` at or after `arrivedAtOrAfter`, looked for in the last
 * `UNREAD_SCAN_MAX_PAGES` pages, newest page first and newest record first within it. Stops at the
 * first match, and at a record older than `arrivedAtOrAfter`, since everything before it is older
 * still. A record with no timestamp neither matches nor stops the scan.
 */
async function hasUnreadMessageSince(
  streams: SessionInputStreams,
  addressingKey: string,
  inTail: number,
  arrivedAtOrAfter: number
): Promise<UnreadScan> {
  // Highest seq the next page may hold.
  let upper = inTail - 1;
  for (let page = 0; page < UNREAD_SCAN_MAX_PAGES && upper >= 0; page++) {
    const afterSeq = Math.max(-1, upper - UNREAD_SCAN_PAGE_SIZE);
    const records = await streams.readSessionStreamRecords(
      addressingKey,
      "in",
      afterSeq,
      undefined,
      upper - afterSeq
    );
    if (records.length === 0) return { status: "nothing-unread" };

    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      if (record.timestamp === undefined) continue;
      if (record.timestamp < arrivedAtOrAfter) return { status: "nothing-unread" };
      // Newest first: this is the latest unread message, not the first, so no seq to report.
      if (isTurnMessage(record.data)) return { status: "unread", firstSeq: undefined };
    }
    upper = afterSeq;
  }
  return { status: "nothing-unread" };
}

/**
 * Whether an `.in` record is a message a run has to answer. A `stop`, the head-start signals and
 * anything unparseable are not. Neither are the two `message` records that are not turns: the
 * `close` that `AgentChat.close()` sends, which a run only reads to exit, and a `preload`, which
 * only warms a run up.
 */
function isTurnMessage(data: string): boolean {
  try {
    const record = JSON.parse(data) as { kind?: unknown; payload?: { trigger?: unknown } } | null;
    if (record?.kind !== "message") return false;
    const trigger = record.payload?.trigger;
    return trigger !== "close" && trigger !== "preload";
  } catch {
    return false;
  }
}

/**
 * Queue the unread-message check for an agent run that ended, when that run is a session's current
 * run. Called from the run-engine handlers for succeeded and failed runs; a cancel is a decision to
 * stop and an expired run never started, so neither is queued. `outcome` says which of the two it
 * was, and rides in the job: a failed run that died inside a turn is not continued (see
 * `continueSessionIfInputUnread`).
 *
 * Cost: nothing for a run that is not an agent run (the annotation comes with the read the caller
 * made anyway); for an agent run one indexed `Session.currentRunId` lookup and, only if it is a
 * session's current run, one queue write. The check itself runs in the queue, retried. It is
 * enqueued with `enqueueOnce`, so a second enqueue for the same run (a repeated event) leaves the
 * queued job alone instead of overwriting it. Never throws.
 */
export async function enqueueSessionRunCompletionCheck(params: {
  run: { id: string; createdAt: Date; annotations: unknown };
  environmentId: string;
  outcome: SessionRunOutcome;
}): Promise<boolean> {
  const { run, environmentId, outcome } = params;
  const annotations = RunAnnotations.safeParse(run.annotations).data;
  if (annotations?.taskKind !== "AGENT") return false;

  const [error, queued] = await tryCatch(
    (async () => {
      const session = await prisma.session.findFirst({
        where: { currentRunId: run.id, runtimeEnvironmentId: environmentId, closedAt: null },
        select: { id: true },
      });
      if (!session) return false;

      // Lazy: a static import would close a module cycle through the worker catalog.
      const { commonWorker } = await import("~/v3/commonWorker.server");
      await commonWorker.enqueueOnce({
        id: `${SESSION_RUN_COMPLETION_JOB}:${run.id}`,
        job: SESSION_RUN_COMPLETION_JOB,
        payload: {
          runId: run.id,
          runCreatedAt: run.createdAt.toISOString(),
          environmentId,
          sessionInSeq: annotations.sessionInSeq,
          sessionInFirstSeq: annotations.sessionInFirstSeq,
          outcome,
        },
      });
      return true;
    })()
  );
  if (error) {
    logger.error("Failed to queue the session continuation check", { runId: run.id, error });
    return false;
  }
  return queued;
}

/**
 * Thrown when the session streams could not be read, on every attempt. It carries
 * `logLevel: "warn"` (the worker logs a failed attempt, and the move to its dead-letter queue after
 * the last one, at the level its error carries), which keeps the worker's lines out of the error
 * reporter. The check logs the unreadable streams once at error level on the last attempt, with
 * the run, the session and the stream names.
 */
class SessionStreamsUnreadableError extends Error {
  readonly logLevel = "warn" as const;

  constructor(runId: string) {
    super(`Could not read the session streams for run ${runId}`);
    this.name = "SessionStreamsUnreadableError";
  }
}

/**
 * The body of the queued job. Fails the attempt when the streams could not be read, so the queue
 * retries it instead of acking a check that looked at nothing. `attempt` is the worker's
 * zero-based attempt count: on the last attempt the check logs the failure at error level before
 * the job throws, so one unreadable run is one error and not one per retry, and the job still
 * reaches the dead-letter queue, where it can be replayed.
 */
export async function runSessionRunCompletionJob(
  payload: z.infer<typeof SessionRunCompletionPayloadSchema>,
  deps: { findEnvironment: (id: string) => Promise<AuthenticatedEnvironment | null> },
  attempt = 0
): Promise<void> {
  const lastAttempt = attempt + 1 >= SESSION_RUN_COMPLETION_MAX_ATTEMPTS;
  const outcome = await continueSessionIfInputUnread(
    {
      run: {
        id: payload.runId,
        createdAt: new Date(payload.runCreatedAt),
        sessionInSeq: payload.sessionInSeq,
        sessionInFirstSeq: payload.sessionInFirstSeq,
      },
      environmentId: payload.environmentId,
      outcome: payload.outcome,
      lastAttempt,
    },
    deps
  );
  // Only "unreadable" is retried: every other outcome, "failed-mid-turn" and "out-commands-only"
  // included, is a final answer. The last attempt throws too, so the worker moves the check to its
  // dead-letter queue (logged at warn, the level the error carries) and it can be replayed once the
  // streams can be read. The check itself logged the failure once at error level on that attempt;
  // that log is wiring, and no test asserts it.
  if (outcome === "unreadable") {
    throw new SessionStreamsUnreadableError(payload.runId);
  }
}

/**
 * The queued check: if the ended run is still its session's current run and `.in` holds a message
 * it never read, start the continuation run, through `ensureRunForSession` (its claim on
 * `currentRunVersion` makes a concurrent append and this check start one run between them).
 * Safe to run again: once a continuation took over, the ended run is no longer current and this
 * finds nothing to do.
 *
 * A run that FAILED (a crash, an out-of-memory kill after the task's retries, the max duration, an
 * error outside the turn loop) is only continued when it ended on a turn-complete of its own, which
 * leaves a message it never started on (an `onSuccess` hook that threw, a crash while idle). One
 * that died inside a turn, or at boot, gets "failed-mid-turn" and nothing starts: its user got no
 * feedback, and a retry of the same message can fail the same way, over and over, so it is left to
 * the user, whose next message starts a run (the append path revives a failed run). An error inside
 * a turn never gets here: chat.agent catches it, writes an error and a turn-complete, and keeps the
 * run alive. A run with no `outcome` (queued by older code) is judged as a succeeded one is.
 *
 * The continuation is started for the first `.in` seq it will answer (`sessionInFirstSeq`), by the
 * rule revive uses too (`firstSeqForNewRun`): the cursor of the last turn-complete on `.out` plus
 * one, which is where a run boots from, else the first unread message the scan found. Those
 * messages are already on `.in`, below the tail it records as `sessionInSeq`, so without a first
 * seq its own turn would look like an earlier run's when it ends. Without a cursor, only the seq
 * scan finds it, and the timestamp fallback (it reads newest first) finds none: the run's first seq
 * is then its `sessionInSeq`.
 *
 * Ordering is what closes the gap: this runs after the status is final, and an append that reused
 * the run re-checks the run's status after its record landed (`reviveReusedRunIfEnded`). A record
 * that landed before the final status is read here; one that lands after it sees a final run and
 * starts the run itself.
 *
 * Cost: one indexed `Session.currentRunId` lookup; for a session's current run one S2 tail peek
 * and one `.in` tail read, then at most three bounded pages of `.in` records. Throws on a failure
 * so the queue retries it; "unreadable" (S2 gave no answer) is for the caller to retry as well, and
 * "out-commands-only" (`.out` read, only command records in it) is final.
 */
export async function continueSessionIfInputUnread(
  params: {
    run: { id: string; createdAt: Date; sessionInSeq?: number; sessionInFirstSeq?: number };
    environmentId: string;
    outcome?: SessionRunOutcome;
    /** The queue will not retry after this check: an unreadable stream is logged at error. */
    lastAttempt?: boolean;
  },
  deps: { findEnvironment: (id: string) => Promise<AuthenticatedEnvironment | null> }
): Promise<SessionContinuationOutcome> {
  const { run, environmentId, outcome, lastAttempt } = params;

  const session = await prisma.session.findFirst({
    where: {
      currentRunId: run.id,
      runtimeEnvironmentId: environmentId,
      closedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: {
      id: true,
      friendlyId: true,
      externalId: true,
      taskIdentifier: true,
      triggerConfig: true,
      currentRunId: true,
      currentRunVersion: true,
      streamBasinName: true,
    },
  });
  if (!session) return "not-a-session-run";

  const environment = await deps.findEnvironment(environmentId);
  if (!environment) return "not-a-session-run";

  const streams = getRealtimeStreamInstance(environment, "v2", { session });
  if (!(streams instanceof S2RealtimeStreams)) return "not-a-session-run";

  const addressingKey = canonicalSessionAddressingKey(session, session.friendlyId);
  const unread = await hasUnreadSessionMessage(streams, addressingKey, run, outcome);
  if (unread.status === "unreadable" || unread.status === "out-commands-only") {
    const context = {
      runId: run.id,
      sessionId: session.friendlyId,
      outStream: streams.toSessionStreamName(addressingKey, "out"),
      inStream: streams.toSessionStreamName(addressingKey, "in"),
    };
    if (unread.status === "out-commands-only") {
      logger.warn(
        "The session's .out holds only command records, so the run's last turn can't be read; not continuing the session",
        context
      );
    } else if (lastAttempt) {
      logger.error("Could not read the session streams after the last attempt", context);
    } else {
      logger.warn("Could not read the session streams, the check will be retried", context);
    }
  }
  if (unread.status !== "unread") return unread.status;

  // The messages are already on `.in`: start the run for the first one it will answer. Unknown
  // only on the timestamp fallback.
  const ensured = await ensureRunForSession({
    session,
    environment,
    reason: "continuation",
    probeOnWriter: true,
    sessionInFirstSeq: unread.firstSeq,
  });
  // Not triggered: a concurrent append already started the run.
  return ensured.triggered ? "continued" : "already-running";
}

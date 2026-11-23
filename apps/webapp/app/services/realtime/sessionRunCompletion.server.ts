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
  | { status: "nothing-unread" | "failed-mid-turn" | "unreadable" }
> {
  const outTail = await streams.peekSessionOutTail(addressingKey);
  if (outTail.kind === "unknown") return { status: "unreadable" };

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
 * The body of the queued job. Fails the attempt when the streams could not be read, so the queue
 * retries it instead of acking a check that looked at nothing.
 */
export async function runSessionRunCompletionJob(
  payload: z.infer<typeof SessionRunCompletionPayloadSchema>,
  deps: { findEnvironment: (id: string) => Promise<AuthenticatedEnvironment | null> }
): Promise<void> {
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
    },
    deps
  );
  // Only "unreadable" is retried: "failed-mid-turn" is a final answer.
  if (outcome === "unreadable") {
    throw new Error(`Could not read the session streams for run ${payload.runId}`);
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
 * so the queue retries it; "unreadable" (S2 gave no answer) is for the caller to retry as well.
 */
export async function continueSessionIfInputUnread(
  params: {
    run: { id: string; createdAt: Date; sessionInSeq?: number; sessionInFirstSeq?: number };
    environmentId: string;
    outcome?: SessionRunOutcome;
  },
  deps: { findEnvironment: (id: string) => Promise<AuthenticatedEnvironment | null> }
): Promise<SessionContinuationOutcome> {
  const { run, environmentId, outcome } = params;

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

  const unread = await hasUnreadSessionMessage(
    streams,
    canonicalSessionAddressingKey(session, session.friendlyId),
    run,
    outcome
  );
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

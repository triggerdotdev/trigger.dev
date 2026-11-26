/**
 * How a chat client tells its own turn apart from the others on a session's
 * `.out`, shared by `AgentChat` (`chat-client.ts`) and the browser
 * `TriggerChatTransport` (`chat.ts`):
 *
 * - finding where a send's turn starts when the client has no `.out` cursor
 *   (`searchTurnStart`, over pages read with `drainOutRecordsPage`), and
 * - deciding, record by record, whose turn the records being read belong to
 *   (`TurnOwnership`), from the `turn-start` / `turn-join` markers an agent
 *   writes and the `.in` cursor its boundaries carry.
 *
 * Like `ai-shared.ts`, this module is reachable from the browser bundle: no
 * `node:*` imports and nothing from `ai.ts`.
 */

import {
  controlSubtype,
  ReadSessionStreamRecordsResponseBody,
  TRIGGER_CONTROL_SUBTYPE,
  TRIGGER_TURN_MARKER_SUBTYPE,
} from "@trigger.dev/core/v3";
import type { UIMessageChunk } from "ai";
import {
  boundaryInCursor,
  isBoundaryBeforeSend,
  PENDING_MESSAGE_INJECTED_TYPE,
  turnJoinCovers,
  turnJoinInjectionId,
  turnStartInSeq,
} from "./ai-shared.js";

/**
 * Page budget for the records drain that finds where a cursorless send's turn
 * starts. The agent trims `.out` to about one turn, so one page is the norm.
 */
const MAX_TURN_START_PAGES = 4;

/** Per request: a page of at most a turn's records is normally back in well under a second. */
const DRAIN_TIMEOUT_MS = 2_000;
const DRAIN_RETRY_DELAY_MS = 200;
/**
 * For the whole turn-start search, which the per-request timeout alone leaves
 * at pages x attempts x timeout (about 16s). It leaves a slow page and its
 * quick retry room, and caps what a send can wait before its stream opens.
 */
const TURN_START_DEADLINE_MS = 3_000;

/**
 * Statuses that say the server has no records endpoint behind this path (a
 * proxy that only forwards the streaming one), as opposed to a failure worth
 * holding the answer back for.
 */
const RECORDS_UNSUPPORTED_STATUSES = new Set([404, 405, 501]);

class OutRecordsUnsupportedError extends Error {}

/**
 * A chat's `.out` URL under `baseURL`: the response stream a client subscribes
 * to, and the base of its `/records` drain.
 */
export function sessionOutUrl(baseURL: string, chatId: string): string {
  return `${baseURL}/realtime/v1/sessions/${encodeURIComponent(chatId)}/out`;
}

/**
 * The console warning for a server or proxy that serves no `.out/records` on a
 * client's path, given once per instance: each client holds its own.
 */
export class OutRecordsUnsupportedWarning {
  private warned = false;

  /**
   * @param client the client's name, which starts the message.
   * @param sendWithoutCursor what reads from the start of the retained output.
   * @param keepCursor what the caller can do instead.
   */
  constructor(
    private readonly client: string,
    private readonly sendWithoutCursor: string,
    private readonly keepCursor: string
  ) {}

  warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      `${this.client}: reading the chat's earlier output isn't supported by this server or proxy, ` +
        `so ${this.sendWithoutCursor} reads from the start of the retained output. ` +
        `With an agent on an older SDK version the reply is held until its turn completes. ` +
        `${this.keepCursor} to avoid reading earlier turns.`
    );
  }
}

/** One `.out/records` entry; the turn-start search reads its seq and headers. */
type OutRecord = ReadSessionStreamRecordsResponseBody["records"][number];

/** Reads one page of `.out/records` after `afterEventId` (the head when absent). */
type ReadOutRecordsPage = (
  afterEventId: string | undefined,
  signal: AbortSignal
) => Promise<OutRecord[]>;

/** What the turn-start search found. */
type TurnStartSearch =
  /**
   * `cursor`: the seq of the last boundary of a turn before the send (the read
   * starts after it), or none when nothing earlier is retained. `hold`: unmarked
   * records after it may still be another message's.
   */
  | { kind: "found"; cursor: number | undefined; hold: boolean }
  /** The server or proxy doesn't serve `.out/records` on this path. */
  | { kind: "unsupported" }
  /** The drain failed, ran past its page budget or its deadline, or was aborted. */
  | { kind: "failed" };

/**
 * One page of `GET <outUrl>/records` (the `wait=0` drain). It sits in front of
 * a send's stream, so it gets a short timeout and at most one quick retry on a
 * 5xx or a network error; anything else, or `signal` aborting, fails at once
 * and the caller falls back to holding chunks. A 404, 405 or 501 says the path
 * serves no records endpoint, which the search reports as `unsupported`.
 *
 * This stays a direct request rather than `apiClient.readSessionStreamRecords`:
 * that call takes no abort signal and runs the API client's retry schedule
 * with no per-request timeout, so it can't be bounded by a caller's abort or
 * the search's deadline without widening core's public API. The response is
 * checked with the same schema core uses for it.
 *
 * `outUrl` is the session's `.out` URL; `fetchClient` is how the caller reaches it.
 */
export async function drainOutRecordsPage(args: {
  outUrl: string;
  afterEventId: string | undefined;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetchClient: typeof fetch;
}): Promise<OutRecord[]> {
  const { outUrl, afterEventId, headers, signal, fetchClient } = args;
  const query =
    afterEventId !== undefined ? `?afterEventId=${encodeURIComponent(afterEventId)}` : "";
  const url = `${outUrl}/records${query}`;

  for (let attempt = 0; ; attempt++) {
    let retryable = true;
    try {
      const response = await fetchClient(url, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(DRAIN_TIMEOUT_MS)]),
      });
      if (response.ok) {
        const body = ReadSessionStreamRecordsResponseBody.safeParse(await response.json());
        // A malformed body is not worth a retry.
        if (!body.success) {
          retryable = false;
          throw new Error("Unexpected records response");
        }
        return body.data.records;
      }
      await response.body?.cancel().catch(() => {});
      if (RECORDS_UNSUPPORTED_STATUSES.has(response.status)) {
        retryable = false;
        throw new OutRecordsUnsupportedError(`No .out/records endpoint: ${response.status}`);
      }
      retryable = response.status >= 500;
      throw new Error(`Reading the .out records failed: ${response.status}`);
    } catch (error) {
      if (!retryable || attempt > 0 || signal.aborted) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, DRAIN_RETRY_DELAY_MS));
  }
}

/**
 * Whose a window's last boundary is, when nothing tells: the window ends on a
 * boundary with no cursor and no records after it, from an agent that writes no
 * cursor at all (none in the window carries one) and no marker explaining it.
 * It is an earlier turn's when the send's reply is still to come, and the
 * send's own when the agent answered before the search read `.out`; the
 * records alone can't tell the two apart.
 *
 * - `"earlier"`: the read starts after it, as `AgentChat` has always read. The
 *   reply streams live; one the agent had already finished isn't seen.
 * - `"own"`: the read starts after the boundary before it and holds until a
 *   boundary, so a reply already on `.out` is delivered, and an idle agent's
 *   previous reply is delivered instead of the send's.
 */
type CursorlessTailBoundary = "earlier" | "own";

/**
 * Drain the retained records for the last boundary of a turn before `inSeq`.
 * The send's turn is then everything after it when that boundary's
 * `session-in-event-id` is `inSeq - 1`: the agent holds that cursor behind any
 * message it has not answered yet, so nothing unanswered sits between the two.
 * A lower one, or none, means earlier messages may still be waiting, and their
 * turns are ahead of this one: the read holds unmarked records until a marker
 * or a boundary says whose they are. A boundary with no cursor is an earlier
 * turn's, unless it ends the window (`cursorlessTail`).
 *
 * One deadline bounds the whole search, ended early by the caller's abort.
 */
export async function searchTurnStart(
  inSeq: number,
  abortSignal: AbortSignal | undefined,
  readPage: ReadOutRecordsPage,
  cursorlessTail: CursorlessTailBoundary = "earlier"
): Promise<TurnStartSearch> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), TURN_START_DEADLINE_MS);
  const signal = abortSignal ? AbortSignal.any([abortSignal, deadline.signal]) : deadline.signal;
  try {
    let after: string | undefined;
    let earlierBoundary: number | undefined;
    let earlierCursor: number | undefined;
    let chunksSinceBoundary = false;
    // A `turn-join` folded my message into the turn now being read, so its
    // boundary closes my turn even when its cursor sits below my seq.
    let joinedMyTurn = false;
    // The turn now being read started from a marker that names my message: its
    // boundary closes my turn whatever cursor it carries. A recovered turn can
    // write its error and completion while the committed cursor sits behind it.
    let startedMyTurn = false;
    // The turn being read started from a marker that named no message (a turn
    // from the start payload or a handover), so its boundary carries no cursor.
    let startedWithoutMessage = false;
    // Whether any boundary carries a cursor: an agent that writes them closes
    // with none only the turns that answered no message.
    let writesCursors = false;
    // The last boundary had no cursor and no marker explaining it, and the one
    // before it, where the read starts if it is the send's own.
    let lastBoundaryUnexplained = false;
    let boundaryBeforeLast: number | undefined;
    const found = (): TurnStartSearch => ({
      kind: "found",
      cursor: earlierBoundary,
      hold: earlierCursor !== inSeq - 1,
    });

    for (let page = 0; page < MAX_TURN_START_PAGES; page++) {
      const records = await readPage(after, signal);
      if (records.length === 0) {
        // Caught up with the tail without meeting a boundary of this turn.
        // Nothing retained after the last boundary: nothing to tell apart.
        if (chunksSinceBoundary) return found();
        if (cursorlessTail === "own" && lastBoundaryUnexplained && !writesCursors) {
          return { kind: "found", cursor: boundaryBeforeLast, hold: true };
        }
        // A cursor below `inSeq - 1` says earlier messages are still owed: one
        // may be about to answer, and its reply must not stream as this send's.
        return {
          kind: "found",
          cursor: earlierBoundary,
          hold: earlierCursor !== undefined && earlierCursor < inSeq - 1,
        };
      }
      for (const record of records) {
        const subtype = controlSubtype(record.headers);
        if (subtype === TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE) {
          const cursor = boundaryInCursor(record.headers);
          // This turn's own boundary (already written). One that closes the
          // turn my message was folded into is mine too: an input or queued
          // action ahead of mine can still be owed, so it carries a lower cursor.
          if (joinedMyTurn || startedMyTurn || (cursor !== undefined && cursor >= inSeq))
            return found();
          // An earlier turn's boundary. One with no cursor closed a turn that
          // answered no message, or comes from an agent that writes no cursor;
          // either way it proves nothing about what follows it.
          if (cursor !== undefined) writesCursors = true;
          lastBoundaryUnexplained = cursor === undefined && !startedWithoutMessage;
          boundaryBeforeLast = earlierBoundary;
          earlierBoundary = record.seqNum;
          earlierCursor = cursor;
          chunksSinceBoundary = false;
          startedWithoutMessage = false;
        } else if (subtype === TRIGGER_TURN_MARKER_SUBTYPE.TURN_JOIN) {
          if (turnJoinCovers(record.headers, inSeq)) joinedMyTurn = true;
        } else if (subtype === TRIGGER_TURN_MARKER_SUBTYPE.TURN_START) {
          joinedMyTurn = false;
          const answers = turnStartInSeq(record.headers);
          startedMyTurn = answers === inSeq;
          startedWithoutMessage = answers === undefined;
        } else if (subtype === undefined && record.headers?.[0]?.[0] !== "") {
          // A data record; other control records and S2 commands say nothing.
          chunksSinceBoundary = true;
        }
      }
      // The server sets no page size, so only an empty page is the tail.
      after = String(records[records.length - 1]!.seqNum);
    }
    return { kind: "failed" };
  } catch (error) {
    return error instanceof OutRecordsUnsupportedError
      ? { kind: "unsupported" }
      : { kind: "failed" };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * The data chunks of the records from `fromSeq` up to (not including) `toSeq`:
 * a turn a stream dropped as another's and then found had answered its own
 * message. Bounded like the turn-start search; a read that fails or isn't
 * served returns what it has, which degrades to the send ending without it.
 */
export async function readTurnBack(
  fromSeq: number,
  toSeq: number,
  signal: AbortSignal,
  readPage: ReadOutRecordsPage
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  // The route takes digits only, so a turn starting at seq 0 reads from the start.
  let after: string | undefined = fromSeq > 0 ? String(fromSeq - 1) : undefined;
  try {
    for (let page = 0; page < MAX_TURN_START_PAGES; page++) {
      const records = await readPage(after, signal);
      if (records.length === 0) break;
      for (const record of records) {
        if (record.seqNum >= toSeq) return chunks;
        if (record.headers && record.headers.length > 0) continue;
        if (record.data && typeof record.data === "object") {
          chunks.push(record.data as UIMessageChunk);
        }
      }
      after = String(records[records.length - 1]!.seqNum);
    }
  } catch {
    // Not readable: the send ends without that turn's output.
  }
  return chunks;
}

/** What a read loop does with one data chunk. */
type ChunkRoute = "drop" | "hold" | "deliver";

/**
 * Whose turn the records a send's stream reads belong to, one record at a time.
 *
 * The agent's `turn-start` marker says which `.in` message the turn that
 * follows answers: another message's turn is dropped as it streams, never
 * buffered, and this send's is delivered live from its marker. A `turn-join`
 * that names this send's message hands it the rest of the running turn, from
 * the step its message first shapes. Records no marker has claimed (an agent
 * that writes none) are held, when the stream can't prove they are this send's,
 * until a boundary says whose they were: an earlier turn's are dropped there,
 * this send's released.
 *
 * `T` is what the caller holds per chunk; the buffer holds at most one turn's
 * unmarked chunks, and is emptied at each marker and boundary.
 */
export class TurnOwnership<T> {
  private owner: "mine" | "other" | "joining" | "unknown" = "unknown";
  /**
   * With "joining": the injection chunk the join record names, which ends the
   * previous step's tail (undefined: the record names none, start at a step).
   */
  private joinInjectionId: string | undefined;
  /** With "other": the record where the dropped turn began, to read it back. */
  private droppedFrom: number | undefined;
  /** With "other": the marker named no message (a turn from the start payload). */
  private startedWithoutMessage = false;
  private held: T[] = [];

  /**
   * @param sinceInSeq `.in` seq of the send the stream answers; a reader with
   *   no send of its own has no turn to tell apart, and ignores the markers.
   * @param holdUnmarked hold records no marker claims until a boundary.
   */
  constructor(
    private readonly sinceInSeq: number | undefined,
    private readonly holdUnmarked: boolean
  ) {}

  /**
   * A `turn-start` marker at record `id`. Nothing held before it can be the
   * turn it starts (an unmarked turn ends at its boundary).
   */
  turnStart(headers: ReadonlyArray<readonly [string, string]> | undefined, id: string): void {
    if (this.sinceInSeq === undefined) return;
    this.held = [];
    const answers = turnStartInSeq(headers);
    this.owner = answers === this.sinceInSeq ? "mine" : "other";
    this.startedWithoutMessage = answers === undefined;
    if (this.owner === "other") this.droppedFrom = Number(id);
  }

  /** A `turn-join` marker: the messages folded into the running turn. */
  turnJoin(headers: ReadonlyArray<readonly [string, string]> | undefined): void {
    if (this.sinceInSeq === undefined || !turnJoinCovers(headers, this.sinceInSeq)) return;
    this.held = [];
    this.owner = "joining";
    this.joinInjectionId = turnJoinInjectionId(headers);
  }

  /**
   * Whether a `turn-complete` closes an earlier turn, which is not this send's
   * to close on: its cursor sits below the send's seq, unless a marker or a join
   * already made the turn this send's (its boundary can carry a lower cursor
   * while an input or queued action ahead of it is still owed). A boundary with
   * no cursor is an earlier turn's only after a marker that named no message;
   * otherwise it is taken as the send's own, as it was before markers.
   *
   * Ownership resets when it is; what was held is that turn's, for the caller to
   * discard (`takeHeld`).
   */
  closesEarlierTurn(headers: ReadonlyArray<readonly [string, string]> | undefined): boolean {
    const earlier =
      (this.owner !== "mine" &&
        this.owner !== "joining" &&
        isBoundaryBeforeSend(headers, this.sinceInSeq)) ||
      (this.owner === "other" &&
        this.startedWithoutMessage &&
        boundaryInCursor(headers) === undefined);
    if (earlier) {
      this.owner = "unknown";
      this.startedWithoutMessage = false;
    }
    return earlier;
  }

  /**
   * At the send's own boundary: where the turn dropped as another's began, when
   * that boundary shows it answered the send after all (folded in with no marker
   * to match, such as a failed marker write or a message read in a recovery).
   */
  droppedTurnStart(): number | undefined {
    return this.owner === "other" &&
      this.droppedFrom !== undefined &&
      Number.isFinite(this.droppedFrom)
      ? this.droppedFrom
      : undefined;
  }

  /**
   * What to do with one data chunk: drop it (another message's turn, or the
   * tail of the step before a join), hold it (`hold`), or deliver it.
   */
  route(chunk: unknown): ChunkRoute {
    if (this.owner === "other") return "drop";
    if (this.owner === "joining") {
      const joined = chunk as { type?: string; id?: string } | null;
      if (this.joinInjectionId !== undefined) {
        // The batched tail of the step before the injection can land after the
        // join record, `start-step` included, so a step boundary can't tell it
        // from the next step. The injection chunk is ordered with that tail: the
        // rest of the turn is what follows it.
        if (joined?.type === PENDING_MESSAGE_INJECTED_TYPE && joined.id === this.joinInjectionId) {
          this.owner = "mine";
        }
        return "drop";
      }
      if (joined?.type !== "start-step") return "drop";
      this.owner = "mine";
    }
    return this.holdUnmarked && this.owner === "unknown" ? "hold" : "deliver";
  }

  /** Holds a chunk `route` said to hold, until a boundary says whose it is. */
  hold(item: T): void {
    this.held.push(item);
  }

  /** Whether anything is held. */
  get holding(): boolean {
    return this.held.length > 0;
  }

  /** Hands back what was held, and empties the buffer. */
  takeHeld(): T[] {
    const held = this.held;
    this.held = [];
    return held;
  }
}

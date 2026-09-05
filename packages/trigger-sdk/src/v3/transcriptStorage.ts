import type { TaskRunContext, TranscriptSnapshotEntry } from "@trigger.dev/core/v3";
import type { UIMessage } from "ai";
import { readChatSnapshot, writeChatSnapshot } from "./chatSnapshotIo.js";

/**
 * One change to a transcript. Ops address messages by id; position is the
 * storage's own concern.
 *
 * - `put` upserts by `message.id`: an unknown id appends, a known id is
 *   replaced in place. `final` is false when the runtime captured a partial
 *   assistant message from an errored or stopped turn; it defaults to true.
 * - `remove` deletes by id and is a no-op for an unknown id.
 * - `truncateAfter` drops every message ordered after `afterId` (a rollback)
 *   and is a no-op when `afterId` is unknown.
 * - `state` replaces the opaque runtime record; `null` clears it.
 */
export type TranscriptChange =
  | { op: "put"; message: UIMessage; final?: boolean }
  | { op: "remove"; id: string }
  | { op: "truncateAfter"; afterId: string }
  | { op: "state"; value: unknown | null };

export type TranscriptChangeReason =
  | "turn-complete"
  | "turn-error"
  | "action"
  | "compaction"
  | "recovery";

type TranscriptCursors = {
  lastOutEventId?: string;
  lastInEventId?: string;
};

/**
 * What the runtime hands to `save`: the ordered changes since the last save
 * (one transaction where the backend supports it), the whole transcript as
 * it stands after those changes, and the stream cursors the next boot should
 * resume from. A row-per-message store applies `changes`; a store that keeps
 * the conversation as one document writes `transcript` as-is and needs no
 * state of its own. Cursors are runtime-computed and persisted opaquely; a
 * storage never interprets them.
 */
type TranscriptChangeset = {
  reason: TranscriptChangeReason;
  changes: TranscriptChange[];
  transcript: TranscriptState;
  cursors?: TranscriptCursors;
};

/** The tenant scope of a read. A render read has no run, so this is all `load` gets. */
type TranscriptScope<TClientData = unknown> = {
  chatId: string;
  clientData: TClientData;
};

/** The run context of a write. Supplied by the runtime; always in-run. */
export type TranscriptStorageContext<TClientData = unknown> = TranscriptScope<TClientData> & {
  turn: number;
  trigger: "submit-message" | "regenerate-message" | "action";
  runId: string;
  ctx: TaskRunContext;
};

type TranscriptLoadOptions = {
  /** Return at most this many messages, the most recent ones. */
  limit?: number;
  /** Return messages ordered before this message id (a `nextCursor` from a previous page). */
  before?: string;
};

type TranscriptLoadResult<TUIMessage extends UIMessage = UIMessage> = {
  messages: TUIMessage[];
  state: unknown | null;
  cursors?: TranscriptCursors;
  /** The id to pass as `before` for the previous page; absent on the last page. */
  nextCursor?: string;
  /**
   * Ids among `messages` that were saved with `final: false` (a partial
   * answer). A storage that keeps `final` returns them so a partial stays
   * partial when a continuation saves it again unchanged; a storage that
   * does not keep `final` may leave this out.
   */
  nonFinalIds?: string[];
};

/**
 * A persistence adapter for a `chat.agent` transcript. The runtime calls
 * `load` once at a continuation boot and `save` after every change to the
 * conversation. Both are best-effort from the runtime's point of view: an
 * error is logged and the turn continues.
 */
export type TranscriptStorage<TClientData = unknown> = {
  load<TUIMessage extends UIMessage = UIMessage>(
    scope: TranscriptScope<TClientData>,
    opts?: TranscriptLoadOptions
  ): Promise<TranscriptLoadResult<TUIMessage>>;
  save(ctx: TranscriptStorageContext<TClientData>, changeset: TranscriptChangeset): Promise<void>;
};

/** An in-memory transcript: ordered entries plus the opaque state record. */
export type TranscriptState<TUIMessage extends UIMessage = UIMessage> = {
  entries: TranscriptSnapshotEntry<TUIMessage>[];
  state: unknown | null;
};

export function emptyTranscriptState<
  TUIMessage extends UIMessage = UIMessage,
>(): TranscriptState<TUIMessage> {
  return { entries: [], state: null };
}

/**
 * Apply changes to a transcript, in order. Pure: returns a new state and
 * never mutates the input. Replaying the same changes converges, which is
 * what lets a storage retry a failed write without checking what landed.
 */
export function reduceTranscriptChanges<TUIMessage extends UIMessage = UIMessage>(
  prev: TranscriptState<TUIMessage>,
  changes: readonly TranscriptChange[]
): TranscriptState<TUIMessage> {
  let entries = prev.entries.slice();
  let state = prev.state;
  for (const change of changes) {
    switch (change.op) {
      case "put": {
        const message = change.message as TUIMessage;
        const entry = { id: message.id, final: change.final ?? true, message };
        const idx = entries.findIndex((e) => e.id === message.id);
        if (idx === -1) entries.push(entry);
        else entries[idx] = entry;
        break;
      }
      case "remove": {
        entries = entries.filter((e) => e.id !== change.id);
        break;
      }
      case "truncateAfter": {
        const idx = entries.findIndex((e) => e.id === change.afterId);
        if (idx !== -1) entries = entries.slice(0, idx + 1);
        break;
      }
      case "state": {
        state = change.value ?? null;
        break;
      }
    }
  }
  return { entries, state };
}

/**
 * What the runtime remembers about the transcript it last handed to
 * `save`: the ids in order and a fingerprint per message, so the next
 * changeset can be derived from the accumulator without asking the storage.
 */
export type TranscriptShadow = {
  ids: string[];
  fingerprints: Map<string, string>;
  /** Ids last saved with `final: false`. Everything else was saved final. */
  nonFinal: Set<string>;
};

function fingerprintMessage(message: UIMessage): string {
  return JSON.stringify(message);
}

/**
 * Build the shadow for `messages`. An id is non-final when this save says so
 * (`nonFinalIds`) or when it was non-final before and its content has not
 * changed: a partial answer stays partial until the message itself changes.
 */
export function createTranscriptShadow(
  messages: readonly UIMessage[],
  nonFinalIds?: ReadonlySet<string>,
  previous?: TranscriptShadow
): TranscriptShadow {
  const ids: string[] = [];
  const fingerprints = new Map<string, string>();
  const nonFinal = new Set<string>();
  for (const message of messages) {
    const fingerprint = fingerprintMessage(message);
    ids.push(message.id);
    fingerprints.set(message.id, fingerprint);
    if (
      nonFinalIds?.has(message.id) ||
      (previous?.nonFinal.has(message.id) && previous.fingerprints.get(message.id) === fingerprint)
    ) {
      nonFinal.add(message.id);
    }
  }
  return { ids, fingerprints, nonFinal };
}

/**
 * Derive the changes that take `shadow` to `next`.
 *
 * The common prefix (by id) is compared message by message and a changed
 * message becomes an in-place `put`. Past the prefix, everything the shadow
 * still had is dropped with one `truncateAfter` on the last common id (or
 * one `remove` per message when there is no common prefix) and everything
 * `next` has is appended with `put`, in order. Applying the result with
 * {@link reduceTranscriptChanges} reproduces `next` exactly, including
 * order, for any two lists.
 */
export function diffTranscript(
  shadow: TranscriptShadow,
  next: readonly UIMessage[],
  options: { nonFinalIds?: ReadonlySet<string> } = {}
): { changes: TranscriptChange[]; shadow: TranscriptShadow } {
  const nextShadow = createTranscriptShadow(next, options.nonFinalIds, shadow);
  const changes: TranscriptChange[] = [];
  const put = (message: UIMessage) => {
    const final = nextShadow.nonFinal.has(message.id) ? false : undefined;
    changes.push(final === undefined ? { op: "put", message } : { op: "put", message, final });
  };

  let lcp = 0;
  while (lcp < shadow.ids.length && lcp < next.length && shadow.ids[lcp] === next[lcp]!.id) {
    lcp++;
  }
  for (let i = 0; i < lcp; i++) {
    const message = next[i]!;
    if (
      shadow.fingerprints.get(message.id) !== nextShadow.fingerprints.get(message.id) ||
      shadow.nonFinal.has(message.id) !== nextShadow.nonFinal.has(message.id)
    ) {
      put(message);
    }
  }
  if (shadow.ids.length > lcp) {
    if (lcp > 0) {
      changes.push({ op: "truncateAfter", afterId: shadow.ids[lcp - 1]! });
    } else {
      for (const id of shadow.ids) changes.push({ op: "remove", id });
    }
  }
  for (let i = lcp; i < next.length; i++) {
    put(next[i]!);
  }
  return { changes, shadow: nextShadow };
}

/**
 * The built-in storage: the whole transcript as one versioned blob in the
 * platform's object store, the same blob the Sessions dashboard renders.
 *
 * Stateless. Every changeset carries the whole transcript as it stands after
 * the changes, so `save` serialises that and rewrites the blob: one PUT per
 * turn, no read and nothing kept in memory between saves.
 */
export function snapshotTranscriptStorage(): TranscriptStorage<unknown> {
  return {
    async load<TUIMessage extends UIMessage = UIMessage>(
      scope: TranscriptScope<unknown>,
      opts?: TranscriptLoadOptions
    ): Promise<TranscriptLoadResult<TUIMessage>> {
      const snapshot = await readChatSnapshot<TUIMessage>(scope.chatId);
      const full: TranscriptState<TUIMessage> = snapshot
        ? { entries: snapshot.messages, state: snapshot.state }
        : emptyTranscriptState<TUIMessage>();

      let entries = full.entries;
      if (opts?.before !== undefined) {
        const idx = entries.findIndex((e) => e.id === opts.before);
        if (idx !== -1) entries = entries.slice(0, idx);
      }
      let nextCursor: string | undefined;
      if (opts?.limit !== undefined && entries.length > opts.limit) {
        entries = entries.slice(entries.length - opts.limit);
        nextCursor = entries[0]?.id;
      }
      return {
        messages: entries.map((e) => e.message),
        state: full.state,
        cursors: snapshot
          ? { lastOutEventId: snapshot.lastOutEventId, lastInEventId: snapshot.lastInEventId }
          : undefined,
        nextCursor,
      };
    },

    async save(ctx, changeset) {
      await writeChatSnapshot(ctx.chatId, {
        version: 2,
        savedAt: Date.now(),
        messages: changeset.transcript.entries,
        state: changeset.transcript.state,
        lastOutEventId: changeset.cursors?.lastOutEventId,
        lastInEventId: changeset.cursors?.lastInEventId,
      });
    },
  };
}

/** The storage `chat.agent` uses when none is configured: {@link snapshotTranscriptStorage}. */
export const defaultStorage: TranscriptStorage<unknown> = snapshotTranscriptStorage();

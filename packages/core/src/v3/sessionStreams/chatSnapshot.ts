/**
 * Persisted chat-snapshot blob. Written by `chat.agent` to S3 after every
 * turn completes (when no `hydrateMessages` hook is registered) and read
 * back at the start of the next run to seed the accumulator. Also read by
 * the Sessions dashboard to render the full conversation transcript
 * without re-streaming `session.out` from `seq_num=0`.
 *
 * S3 key suffix: `sessions/{sessionId}/snapshot.json`. The webapp's
 * presigned-URL service prefixes this with `packets/{projectRef}/{envSlug}/`.
 *
 * `lastOutEventId` is the S2 seq_num (as a string) of the snapshot's
 * final `turn-complete` control record. Used to resume `session.out`
 * replay from precisely after the snapshot, and as the trim-chain seed
 * for the agent's next turn.
 *
 * The `version` field is a forward-compat lever: readers that don't
 * recognise a version silently fall back to no-snapshot behaviour.
 */

import { z } from "zod/v4";

import type { UIMessage } from "ai";

export type ChatSnapshotV1<TUIMessage = unknown> = {
  version: 1;
  savedAt: number;
  messages: TUIMessage[];
  lastOutEventId?: string;
  /**
   * Committed `.in` consume cursor (S2 seq_num, stringified) as of this
   * snapshot's turn-complete. Lets the next boot seed the `.in` resume
   * cursor without scanning `session.out` for the latest turn-complete
   * header. Absent on snapshots written before this field existed —
   * readers fall back to the scan.
   */
  lastInEventId?: string;
};

/**
 * Zod schema for `ChatSnapshotV1` with the message shape kept opaque
 * (`unknown[]`). The agent runtime types messages strictly via the
 * generic parameter; readers that need stricter validation can layer
 * their own UIMessage parser on top.
 */
export const ChatSnapshotV1Schema = z.object({
  version: z.literal(1),
  savedAt: z.number().optional(),
  messages: z.array(z.unknown()),
  lastOutEventId: z.string().optional(),
  lastInEventId: z.string().optional(),
});

/**
 * One transcript entry in a version 2 snapshot. `id` duplicates
 * `message.id` so a reader can address entries without inspecting the
 * message body; `final` is false for a partial assistant message captured
 * by an errored or stopped turn.
 */
export type TranscriptSnapshotEntry<TUIMessage extends UIMessage = UIMessage> = {
  id: string;
  final: boolean;
  message: TUIMessage;
};

/**
 * Version 2 of the persisted transcript blob. Entries are ordered by array
 * position. `state` is an opaque record the runtime uses for compaction and
 * other cross-run bookkeeping; `null` when nothing has been recorded.
 *
 * Readers must accept version 1 as well; writers only emit version 2. Use
 * {@link parseTranscriptSnapshot} to read either.
 */
export type TranscriptSnapshotV2<TUIMessage extends UIMessage = UIMessage> = {
  version: 2;
  savedAt: number;
  messages: TranscriptSnapshotEntry<TUIMessage>[];
  state: unknown | null;
  lastOutEventId?: string;
  lastInEventId?: string;
};

export const TranscriptSnapshotV2Schema = z.object({
  version: z.literal(2),
  savedAt: z.number().optional(),
  messages: z.array(
    z.object({
      id: z.string(),
      final: z.boolean(),
      message: z.unknown(),
    })
  ),
  state: z.unknown().nullable(),
  lastOutEventId: z.string().optional(),
  lastInEventId: z.string().optional(),
});

/**
 * Parse a fetched snapshot blob of any known version into the version 2
 * shape. A version 1 blob is upgraded in memory: every message becomes a
 * `final: true` entry keyed by its `id` and `state` is `null`. In both
 * versions, entries without a non-empty string `id` or a non-null object
 * `message` are dropped; a version 2 entry whose `message.id` disagrees with
 * the envelope `id` is dropped too, since a reader keys by one and renders by
 * the other. A caller never sees an entry it would crash on or mis-order.
 * A missing `savedAt` defaults to `0` rather than rejecting the whole blob:
 * the field only orders snapshot history before live chunks, and dropping a
 * whole conversation over an absent timestamp is the wrong failure mode.
 * Returns `undefined` for an unknown version or a body that is not a
 * snapshot; callers treat that as "no snapshot".
 */
export function parseTranscriptSnapshot<TUIMessage extends UIMessage = UIMessage>(
  input: unknown
): TranscriptSnapshotV2<TUIMessage> | undefined {
  const v2 = TranscriptSnapshotV2Schema.safeParse(input);
  if (v2.success) {
    const messages: TranscriptSnapshotEntry<TUIMessage>[] = [];
    for (const entry of v2.data.messages) {
      if (entry.id.length === 0) continue;
      if (typeof entry.message !== "object" || entry.message === null) continue;
      if ((entry.message as { id?: unknown }).id !== entry.id) continue;
      messages.push({ id: entry.id, final: entry.final, message: entry.message as TUIMessage });
    }
    return {
      version: 2,
      savedAt: v2.data.savedAt ?? 0,
      messages,
      state: v2.data.state ?? null,
      lastOutEventId: v2.data.lastOutEventId,
      lastInEventId: v2.data.lastInEventId,
    };
  }

  const v1 = ChatSnapshotV1Schema.safeParse(input);
  if (v1.success) {
    const messages: TranscriptSnapshotEntry<TUIMessage>[] = [];
    for (const raw of v1.data.messages) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      messages.push({ id, final: true, message: raw as TUIMessage });
    }
    return {
      version: 2,
      savedAt: v1.data.savedAt ?? 0,
      messages,
      state: null,
      lastOutEventId: v1.data.lastOutEventId,
      lastInEventId: v1.data.lastInEventId,
    };
  }

  return undefined;
}

/**
 * Select one page of transcript entries, newest last. `before` keeps only the
 * entries ordered before that id, and yields an empty page when the transcript
 * no longer holds that id; `limit` keeps the last that many. A
 * non-positive `limit` is treated as no limit (every entry, no cursor), so a
 * caller cannot mistake an empty page for the end of the transcript. The
 * returned `nextCursor` is the id to pass as `before` for the previous page,
 * absent when there is no earlier page.
 */
export function pageTranscriptEntries<TUIMessage extends UIMessage = UIMessage>(
  all: TranscriptSnapshotEntry<TUIMessage>[],
  opts: { limit?: number; before?: string } | undefined
): { entries: TranscriptSnapshotEntry<TUIMessage>[]; nextCursor: string | undefined } {
  let entries = all;
  if (opts?.before !== undefined) {
    const idx = entries.findIndex((e) => e.id === opts.before);
    if (idx === -1) return { entries: [], nextCursor: undefined };
    entries = entries.slice(0, idx);
  }
  let nextCursor: string | undefined;
  if (opts?.limit !== undefined && opts.limit > 0 && entries.length > opts.limit) {
    entries = entries.slice(entries.length - opts.limit);
    nextCursor = entries[0]?.id;
  }
  return { entries, nextCursor };
}

/**
 * S3 key suffix for a session's snapshot blob. The webapp's presigned
 * URL routes prefix this with `packets/{projectRef}/{envSlug}/`.
 */
export function chatSnapshotKeySuffix(sessionId: string): string {
  return `sessions/${sessionId}/snapshot.json`;
}

/**
 * Byte length of the fixed trailer that ends a version 2 blob:
 * `#tt2:` + 16 zero-padded digits + `\n`. Fixed width so a reader can fetch
 * exactly this many bytes from the end of the object and learn where the
 * footer starts without a second guess.
 */
export const TRANSCRIPT_TRAILER_BYTES = 22;

/**
 * Media type a version 2 blob is stored under. Object stores return this on a
 * ranged read, so a reader learns the format from the response it already made
 * instead of inferring it from the bytes.
 */
export const TRANSCRIPT_BLOB_CONTENT_TYPE = "application/vnd.trigger.transcript+ndjson";

const TRAILER_PREFIX = "#tt2:";
const V2_LINE_PREFIX = '{"v":2';

/**
 * Entry index at the end of a version 2 blob. Carries the stream cursors too,
 * so serving a transcript page never has to fetch the header — which is where
 * the private runtime state lives. `offsets` holds `ids.length + 1`
 * byte offsets: entry `i` occupies `[offsets[i], offsets[i + 1] - 1)`, and the
 * final sentinel is where the footer line itself begins. Carrying the sentinel
 * means a reader can bound every entry, including the last, without knowing the
 * object's total size.
 */
export type TranscriptFooter = {
  ids: string[];
  offsets: number[];
  savedAt?: number;
  lastOutEventId?: string;
  lastInEventId?: string;
};

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Serialize a snapshot to the version 2 blob format: a header line carrying
 * the cursors and the private runtime `state`, one JSON entry per line, an
 * entry-index footer line, and the fixed trailer.
 *
 * The header holds `state`, so a reader that fetches only the end of the
 * object to serve a transcript page cannot receive the model lane even by
 * accident.
 */
export function serializeTranscriptSnapshot<TUIMessage extends UIMessage>(
  snapshot: TranscriptSnapshotV2<TUIMessage>
): string {
  const header = JSON.stringify({
    v: 2,
    savedAt: snapshot.savedAt,
    lastOutEventId: snapshot.lastOutEventId,
    lastInEventId: snapshot.lastInEventId,
    state: snapshot.state ?? null,
  });

  const ids: string[] = [];
  const offsets: number[] = [];
  const lines: string[] = [];

  let cursor = utf8Length(header) + 1;
  for (const entry of snapshot.messages) {
    const line = JSON.stringify({ id: entry.id, final: entry.final, message: entry.message });
    ids.push(entry.id);
    offsets.push(cursor);
    lines.push(line);
    cursor += utf8Length(line) + 1;
  }
  offsets.push(cursor);

  const footer = JSON.stringify({
    ids,
    offsets,
    savedAt: snapshot.savedAt,
    lastOutEventId: snapshot.lastOutEventId,
    lastInEventId: snapshot.lastInEventId,
  });
  const trailer = `${TRAILER_PREFIX}${String(utf8Length(footer)).padStart(16, "0")}\n`;

  return `${header}\n${lines.map((line) => `${line}\n`).join("")}${footer}\n${trailer}`;
}

/**
 * Read the fixed trailer from the last {@link TRANSCRIPT_TRAILER_BYTES} bytes
 * of a version 2 blob. Returns the footer line's byte length, or `undefined`
 * when the bytes are not a trailer (a version 1 blob, or a truncated write).
 */
export function readTranscriptTrailer(trailer: string): { footerLength: number } | undefined {
  if (!trailer.startsWith(TRAILER_PREFIX) || trailer.length !== TRANSCRIPT_TRAILER_BYTES) {
    return undefined;
  }
  const digits = trailer.slice(TRAILER_PREFIX.length, TRANSCRIPT_TRAILER_BYTES - 1);
  if (!/^\d{16}$/.test(digits)) return undefined;
  const footerLength = Number(digits);
  return Number.isSafeInteger(footerLength) && footerLength >= 0 ? { footerLength } : undefined;
}

/** Parse a version 2 footer line into its entry index. */
export function parseTranscriptFooter(line: string): TranscriptFooter | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { ids, offsets } = parsed as { ids?: unknown; offsets?: unknown };
  if (!Array.isArray(ids) || !Array.isArray(offsets)) return undefined;
  if (offsets.length !== ids.length + 1) return undefined;
  if (!ids.every((id) => typeof id === "string")) return undefined;
  if (!offsets.every((offset) => typeof offset === "number" && Number.isSafeInteger(offset))) {
    return undefined;
  }
  // Offsets must strictly increase. Every entry is a non-empty JSON line plus a
  // newline, so consecutive offsets always differ; equal or descending ones mean
  // corrupt metadata. Accepting equality would hand the reader a zero-length
  // window, which decodes to no entry at all and drops a message from the page
  // while the cursor advances past it, instead of declining here so the caller
  // takes the whole-object fallback.
  const numeric = offsets as number[];
  if (numeric[0]! < 0) return undefined;
  for (let i = 1; i < numeric.length; i++) {
    if (numeric[i]! <= numeric[i - 1]!) return undefined;
  }
  const { savedAt, lastOutEventId, lastInEventId } = parsed as {
    savedAt?: unknown;
    lastOutEventId?: unknown;
    lastInEventId?: unknown;
  };
  return {
    ids: ids as string[],
    offsets: offsets as number[],
    savedAt: typeof savedAt === "number" ? savedAt : undefined,
    lastOutEventId: typeof lastOutEventId === "string" ? lastOutEventId : undefined,
    lastInEventId: typeof lastInEventId === "string" ? lastInEventId : undefined,
  };
}

/**
 * Byte window covering one page of entries within a single object, computed
 * from its footer alone. Mirrors {@link pageTranscriptEntries}: newest last,
 * `before` excludes that id and everything after it, `limit` keeps the last
 * that many.
 *
 * `undefined` means the page is empty: the transcript is empty, `before` names
 * its first entry, or `before` names an entry the transcript no longer holds
 * (history trimmed since the caller last read it). Returning the newest entries
 * for a cursor that cannot be found would present recent messages as older ones.
 */
export type TranscriptPagePlan = {
  start: number;
  end: number;
  ids: string[];
  /** Set when the transcript still holds entries before the page. */
  nextCursor: string | undefined;
  /** Position of the page's first entry in the whole transcript. */
  startIndex: number;
  /** Entries in the whole transcript, so a caller can order pages against each other. */
  totalEntries: number;
};

export function planTranscriptPage(
  footer: TranscriptFooter,
  opts: { limit?: number; before?: string } | undefined
): TranscriptPagePlan | undefined {
  let endIndex = footer.ids.length;
  if (opts?.before !== undefined) {
    const idx = footer.ids.indexOf(opts.before);
    if (idx === -1) return undefined;
    endIndex = idx;
  }

  const limit = opts?.limit !== undefined && opts.limit > 0 ? opts.limit : undefined;

  let startIndex = 0;
  let nextCursor: string | undefined;
  if (limit !== undefined && endIndex > limit) {
    startIndex = endIndex - limit;
    nextCursor = footer.ids[startIndex];
  }

  if (endIndex <= startIndex) return undefined;

  return {
    start: footer.offsets[startIndex]!,
    end: footer.offsets[endIndex]!,
    ids: footer.ids.slice(startIndex, endIndex),
    nextCursor,
    startIndex,
    totalEntries: footer.ids.length,
  };
}

function parseEntryLine<TUIMessage extends UIMessage>(
  line: string
): TranscriptSnapshotEntry<TUIMessage> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { id, final, message } = parsed as { id?: unknown; final?: unknown; message?: unknown };
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof message !== "object" || message === null) return undefined;
  if ((message as { id?: unknown }).id !== id) return undefined;
  return { id, final: final === true, message: message as TUIMessage };
}

/**
 * Parse a run of whole entry lines, e.g. the byte window
 * {@link planTranscriptPage} selected. Malformed lines are dropped, matching
 * {@link parseTranscriptSnapshot}: a caller never sees an entry it would crash
 * on or mis-order.
 */
export function parseTranscriptEntryLines<TUIMessage extends UIMessage = UIMessage>(
  text: string
): TranscriptSnapshotEntry<TUIMessage>[] {
  const entries: TranscriptSnapshotEntry<TUIMessage>[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const entry = parseEntryLine<TUIMessage>(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Parse a whole fetched blob of any known format. Version 2 is the line-based
 * format {@link serializeTranscriptSnapshot} writes; anything else is handed to
 * {@link parseTranscriptSnapshot}, which still reads the version 1 blobs
 * written by released SDKs.
 */
export function parseTranscriptBlob<TUIMessage extends UIMessage = UIMessage>(
  text: string
): TranscriptSnapshotV2<TUIMessage> | undefined {
  if (!text.startsWith(V2_LINE_PREFIX)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    return parseTranscriptSnapshot<TUIMessage>(parsed);
  }

  const newline = text.indexOf("\n");
  if (newline === -1) return undefined;

  let header: unknown;
  try {
    header = JSON.parse(text.slice(0, newline));
  } catch {
    return undefined;
  }
  const { savedAt, lastOutEventId, lastInEventId, state } = (header ?? {}) as {
    savedAt?: unknown;
    lastOutEventId?: unknown;
    lastInEventId?: unknown;
    state?: unknown;
  };

  const trailerStart = text.length - TRANSCRIPT_TRAILER_BYTES;
  const trailer = trailerStart >= 0 ? readTranscriptTrailer(text.slice(trailerStart)) : undefined;

  let body = text.slice(newline + 1);
  if (trailer) {
    // Drop the footer line and the trailer; the entries are everything between
    // the header and them.
    const footerLine = text.lastIndexOf("\n", trailerStart - 2);
    if (footerLine > newline) body = text.slice(newline + 1, footerLine + 1);
  }

  return {
    version: 2,
    savedAt: typeof savedAt === "number" ? savedAt : 0,
    messages: parseTranscriptEntryLines<TUIMessage>(body),
    state: state ?? null,
    lastOutEventId: typeof lastOutEventId === "string" ? lastOutEventId : undefined,
    lastInEventId: typeof lastInEventId === "string" ? lastInEventId : undefined,
  };
}

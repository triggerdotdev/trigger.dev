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

import { z } from "zod";

import type { UIMessage } from "ai";

export type ChatSnapshotV1<TUIMessage extends UIMessage = UIMessage> = {
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
  savedAt: z.number(),
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
  savedAt: z.number(),
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
 * `final: true` entry keyed by its `id` (entries without a string `id` are
 * dropped) and `state` is `null`. Returns `undefined` for an unknown
 * version or a body that is not a snapshot; callers treat that as
 * "no snapshot".
 */
export function parseTranscriptSnapshot<TUIMessage extends UIMessage = UIMessage>(
  input: unknown
): TranscriptSnapshotV2<TUIMessage> | undefined {
  const v2 = TranscriptSnapshotV2Schema.safeParse(input);
  if (v2.success) {
    return {
      version: 2,
      savedAt: v2.data.savedAt,
      messages: v2.data.messages.map((entry) => ({
        id: entry.id,
        final: entry.final,
        message: entry.message as TUIMessage,
      })),
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
      savedAt: v1.data.savedAt,
      messages,
      state: null,
      lastOutEventId: v1.data.lastOutEventId,
      lastInEventId: v1.data.lastInEventId,
    };
  }

  return undefined;
}

/**
 * S3 key suffix for a session's snapshot blob. The webapp's presigned
 * URL routes prefix this with `packets/{projectRef}/{envSlug}/`.
 */
export function chatSnapshotKeySuffix(sessionId: string): string {
  return `sessions/${sessionId}/snapshot.json`;
}

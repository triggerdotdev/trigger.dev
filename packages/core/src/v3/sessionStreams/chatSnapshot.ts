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
 * `lastOutTimestamp` is the same record's S2 arrival timestamp (ms since
 * epoch). Used as the dedup cutoff for `session.in` on OOM-retry boot.
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
  lastOutTimestamp?: number;
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
  lastOutTimestamp: z.number().optional(),
});

/**
 * S3 key suffix for a session's snapshot blob. The webapp's presigned
 * URL routes prefix this with `packets/{projectRef}/{envSlug}/`.
 */
export function chatSnapshotKeySuffix(sessionId: string): string {
  return `sessions/${sessionId}/snapshot.json`;
}

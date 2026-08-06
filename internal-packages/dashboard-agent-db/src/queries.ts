import {
  investigationBlockSchema,
  VIEW_BLOCK_VERSION,
  WATCH_REQUEST_MESSAGE_ID_PREFIX,
} from "@internal/dashboard-agent-contracts";
import { and, desc, eq, ne, sql, isNull } from "drizzle-orm";
import type { DashboardAgentDb } from "./client.js";
import { generateInvestigationId } from "./ids.js";
import { lockChatForWatches, type DashboardAgentDbOrTx } from "./internal.js";
import {
  chats,
  chatSessions,
  chatTurnEvals,
  investigations,
  type ChatSession,
  type Investigation,
  type NewChatTurnEval,
  type Watch,
} from "./schema.js";
import { cancelActiveWatchesForChat } from "./watch-queries.js";

// The watch, wake and batch-chain queries live in `watch-queries.js`, re-exported
// here so every existing import path still resolves.
export * from "./watch-queries.js";

// Every query that touches user data must be scoped by `organizationId` and/or
// `userId`. This file is where tenant isolation lives.

export const DEFAULT_CHAT_TITLE = "New chat";

export interface ChatListItem {
  id: string;
  title: string;
  pinnedAt: Date | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

/** Never selects `messages` or the session token. Covered by `chats_org_user_last_msg_idx`. */
export async function listChats(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string; limit?: number }
): Promise<ChatListItem[]> {
  return db
    .select({
      id: chats.id,
      title: chats.title,
      pinnedAt: chats.pinnedAt,
      lastMessageAt: chats.lastMessageAt,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      metadata: chats.metadata,
    })
    .from(chats)
    .where(
      and(
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt)
      )
    )
    .orderBy(sql`${chats.pinnedAt} desc nulls last`, desc(chats.lastMessageAt))
    .limit(params.limit ?? 50);
}

/** Null if the chat is missing, deleted, or not this user's. */
export async function getChatMessages(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string }
): Promise<unknown[] | null> {
  const rows = await db
    .select({ messages: chats.messages })
    .from(chats)
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.userId, params.userId),
        eq(chats.organizationId, params.organizationId),
        isNull(chats.deletedAt)
      )
    )
    .limit(1);
  return rows[0]?.messages ?? null;
}

/**
 * Counted from the stored transcripts, not a counter column, so a deleted chat stops
 * counting. `excludeChatId` is for a caller that counts that chat's live messages itself.
 * A watch's consent record is a user message but not a turn the user spent, so it is
 * excluded here and by the client-side count.
 */
export async function countUserMessages(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string; excludeChatId?: string }
): Promise<number> {
  const rows = await db
    .select({
      count: sql<number>`coalesce(sum((
        select count(*)
        from jsonb_array_elements(${chats.messages}) as message
        where message->>'role' = 'user'
          and coalesce(message->>'id', '') not like ${`${WATCH_REQUEST_MESSAGE_ID_PREFIX}%`}
      )), 0)::int`,
    })
    .from(chats)
    .where(
      and(
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt),
        params.excludeChatId ? ne(chats.id, params.excludeChatId) : undefined
      )
    );
  return rows[0]?.count ?? 0;
}

/** Joins `chats` to scope by owner, because `chat_sessions` has no `userId`. */
export async function getSession(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string }
): Promise<ChatSession | null> {
  const rows = await db
    .select({
      chatId: chatSessions.chatId,
      publicAccessToken: chatSessions.publicAccessToken,
      lastEventId: chatSessions.lastEventId,
      runId: chatSessions.runId,
      updatedAt: chatSessions.updatedAt,
    })
    .from(chatSessions)
    .innerJoin(chats, eq(chats.id, chatSessions.chatId))
    .where(
      and(
        eq(chatSessions.chatId, params.chatId),
        eq(chats.userId, params.userId),
        eq(chats.organizationId, params.organizationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Owner check for chat-scoped actions, before a session row necessarily exists. */
export async function chatExists(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string }
): Promise<boolean> {
  const rows = await db
    .select({ id: chats.id })
    .from(chats)
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Idempotent: the webapp's insert and the agent's ensure-exists race. */
export async function createChat(
  db: DashboardAgentDb,
  params: {
    id: string;
    organizationId: string;
    userId: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db
    .insert(chats)
    .values({
      id: params.id,
      organizationId: params.organizationId,
      userId: params.userId,
      title: params.title ?? DEFAULT_CHAT_TITLE,
      metadata: params.metadata ?? {},
    })
    .onConflictDoNothing();
}

export const ensureChat = createChat;

export async function renameChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string; title: string }
): Promise<void> {
  await db
    .update(chats)
    .set({ title: params.title, updatedAt: sql`now()` })
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.userId, params.userId),
        eq(chats.organizationId, params.organizationId)
      )
    );
}

/** So the background title write can't clobber a user rename, and is safe to repeat. */
export async function setChatTitleIfDefault(
  db: DashboardAgentDb,
  params: { chatId: string; title: string }
): Promise<void> {
  await db
    .update(chats)
    .set({ title: params.title, updatedAt: sql`now()` })
    .where(
      and(eq(chats.id, params.chatId), eq(chats.title, DEFAULT_CHAT_TITLE), isNull(chats.deletedAt))
    );
}

export async function setChatPinned(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string; pinned: boolean }
): Promise<void> {
  await db
    .update(chats)
    .set({ pinnedAt: params.pinned ? sql`now()` : null, updatedAt: sql`now()` })
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.userId, params.userId),
        eq(chats.organizationId, params.organizationId)
      )
    );
}

/** Owner-scoped: a client chatId can only clear the caller's own unread state. */
export async function markChatRead(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string; at?: Date }
): Promise<void> {
  await db
    .update(chats)
    .set({ lastReadAt: params.at ?? sql`now()` })
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.userId, params.userId),
        eq(chats.organizationId, params.organizationId)
      )
    );
}

/**
 * One transaction on purpose: a crash between the two halves would leave live
 * watches ticking against a chat the user can no longer see. Owner-scoped.
 */
export async function softDeleteChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<{ deleted: boolean; cancelledWatches: Watch[] }> {
  return db.transaction(async (tx) => {
    // The same lock `createWatch` takes, or a concurrent create lands an active
    // watch on a chat this transaction already deleted.
    await lockChatForWatches(tx, params.chatId);

    const deleted = await tx
      .update(chats)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(chats.id, params.chatId), eq(chats.userId, params.userId)))
      .returning({ id: chats.id });

    if (deleted.length === 0) return { deleted: false, cancelledWatches: [] };

    const cancelledWatches = await cancelActiveWatchesForChat(tx, {
      chatId: params.chatId,
      reason: "chat_deleted",
    });

    return { deleted: true, cancelledWatches };
  });
}

/** Identity for the merge: the stable message id, or the content when a message has none. */
function messageKey(message: unknown): string {
  const id = (message as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? `id:${id}` : `raw:${JSON.stringify(message)}`;
}

/**
 * The turn's snapshot, plus whatever the row gained while the turn was running.
 *
 * A wholesale `SET messages = <snapshot>` deletes anything another process appended
 * after the snapshot was taken — a wake, a watch consent record, or the terminal card
 * of a settled investigation, which is unrecoverable: the row is already terminal, so
 * the stale sweep never selects it again and the panel spins for ever.
 *
 * Incoming order is kept, a stored message the snapshot doesn't have goes at the end,
 * and no key appears twice.
 */
export function mergeStoredMessages(incoming: unknown[], stored: unknown[]): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const message of [...incoming, ...stored]) {
    const key = messageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

/** Reads the row under its own lock, so a concurrent append can't be merged away. */
async function writeMergedMessages(
  tx: DashboardAgentDbOrTx,
  params: { chatId: string; messages: unknown[] }
): Promise<void> {
  const rows = await tx
    .select({ messages: chats.messages })
    .from(chats)
    .where(eq(chats.id, params.chatId))
    .limit(1)
    .for("update");

  const stored = rows[0]?.messages;
  await tx
    .update(chats)
    .set({
      messages: mergeStoredMessages(params.messages, Array.isArray(stored) ? stored : []),
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(chats.id, params.chatId));
}

/** No session state, unlike {@link persistTurn}. */
export async function persistMessages(
  db: DashboardAgentDb,
  params: { chatId: string; messages: unknown[] }
): Promise<void> {
  await db.transaction((tx) => writeMergedMessages(tx, params));
}

/**
 * `||` on the JSONB column is one statement, so it can't lose a concurrent turn's
 * write the way a read-modify-write would. Owner- and live-chat-scoped.
 */
export async function appendChatMessage(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string; message: unknown }
): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({
      messages: sql`coalesce(${chats.messages}, '[]'::jsonb) || ${JSON.stringify([params.message])}::jsonb`,
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.userId, params.userId),
        eq(chats.organizationId, params.organizationId),
        isNull(chats.deletedAt)
      )
    )
    .returning({ id: chats.id });

  return rows.length > 0;
}

/**
 * Idempotent on the message's `id`, for retrying callers like the wake narration.
 *
 * `organizationId` is optional only because the agent runtime's callers don't carry one
 * yet; when it is given it is verified, so a chat id from another org appends nothing.
 */
export async function appendChatMessageOnce(
  db: DashboardAgentDb,
  params: {
    chatId: string;
    userId: string;
    organizationId?: string;
    message: { id: string };
  }
): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({
      messages: sql`coalesce(${chats.messages}, '[]'::jsonb) || ${JSON.stringify([params.message])}::jsonb`,
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.userId, params.userId),
        ...(params.organizationId ? [eq(chats.organizationId, params.organizationId)] : []),
        isNull(chats.deletedAt),
        sql`not exists (select 1 from jsonb_array_elements(coalesce(${chats.messages}, '[]'::jsonb)) m where m->>'id' = ${params.message.id})`
      )
    )
    .returning({ id: chats.id });

  return rows.length > 0;
}

/**
 * Same id-deduped append, for the lanes that have a chat id and no user in context —
 * the between-turns sweep runs on its own, off any session.
 */
export async function appendChatMessageOnceByChatId(
  db: DashboardAgentDbOrTx,
  params: { chatId: string; message: { id: string } }
): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({
      messages: sql`coalesce(${chats.messages}, '[]'::jsonb) || ${JSON.stringify([params.message])}::jsonb`,
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(chats.id, params.chatId),
        isNull(chats.deletedAt),
        sql`not exists (select 1 from jsonb_array_elements(coalesce(${chats.messages}, '[]'::jsonb)) m where m->>'id' = ${params.message.id})`
      )
    )
    .returning({ id: chats.id });

  return rows.length > 0;
}

/** An investigation the turn left running, and the terminal state to close it with. */
export type PendingInvestigationSettlement = {
  id: string;
  projectRef: string;
  environmentRef: string;
  state: unknown;
};

export type PersistTurnResult = { settled: SettledInvestigation[] };

/**
 * One transaction: the frontend reads `messages` and `lastEventId` in parallel, so a
 * torn write resumes from a stale cursor and double-renders the last turn.
 *
 * `settlements` closes the cards the turn left running in that same transaction. It has
 * to be the same one: a settled row whose closing card didn't land is a terminal row the
 * stale sweep no longer selects, and the panel renders the spinner forever.
 */
export async function persistTurn(
  db: DashboardAgentDb,
  params: {
    chatId: string;
    messages: unknown[];
    session: {
      publicAccessToken: string;
      lastEventId?: string | null;
      runId?: string | null;
    };
    settlements?: PendingInvestigationSettlement[];
  }
): Promise<PersistTurnResult> {
  return db.transaction(async (tx) => {
    const settled: SettledInvestigation[] = [];
    const cards: InvestigationCardMessage[] = [];
    for (const pending of params.settlements ?? []) {
      const result = await upsertInvestigationRevision(tx, {
        id: pending.id,
        chatId: params.chatId,
        projectRef: pending.projectRef,
        environmentRef: pending.environmentRef,
        state: pending.state,
      });
      // A row that no longer belongs to this chat/project/env has nothing to close.
      if (!result.ok) continue;

      const message = investigationSettlementMessage({
        investigationId: result.id,
        revision: result.revision,
        state: pending.state,
      });
      if (!message) {
        throw new Error(`Investigation ${result.id} settled to a state that isn't renderable`);
      }
      settled.push({ id: result.id, revision: result.revision, state: pending.state });
      cards.push(message);
    }

    // Revision-stable ids, so a replayed turn writes the same transcript, not a second card.
    const existing = new Set(
      params.messages.flatMap((message) => {
        const id = (message as { id?: unknown }).id;
        return typeof id === "string" ? [id] : [];
      })
    );
    const messages = [...params.messages, ...cards.filter((card) => !existing.has(card.id))];

    await writeMergedMessages(tx, { chatId: params.chatId, messages });

    await tx
      .insert(chatSessions)
      .values({
        chatId: params.chatId,
        publicAccessToken: params.session.publicAccessToken,
        lastEventId: params.session.lastEventId ?? null,
        runId: params.session.runId ?? null,
      })
      .onConflictDoUpdate({
        target: chatSessions.chatId,
        set: {
          publicAccessToken: params.session.publicAccessToken,
          lastEventId: params.session.lastEventId ?? null,
          runId: params.session.runId ?? null,
          updatedAt: sql`now()`,
        },
      });

    return { settled };
  });
}

/** Idempotent on `(chatId, turn)`: a retried eval task can't write a second row. */
export async function insertTurnEval(db: DashboardAgentDb, row: NewChatTurnEval): Promise<void> {
  await db.insert(chatTurnEvals).values(row).onConflictDoNothing();
}

/**
 * Retention for the judged-turn rows. One bounded statement, oldest first, so a
 * backlog drains over several runs instead of locking the table in one pass.
 */
export async function deleteTurnEvalsOlderThan(
  db: DashboardAgentDb,
  params: { before: Date; limit?: number }
): Promise<number> {
  // Raw statement because the key is composite: drizzle's `inArray` takes one column.
  const deleted = await db.execute<{ chat_id: string }>(sql`
    delete from ${chatTurnEvals}
    where (${chatTurnEvals.chatId}, ${chatTurnEvals.turn}) in (
      select ${chatTurnEvals.chatId}, ${chatTurnEvals.turn}
      from ${chatTurnEvals}
      where ${chatTurnEvals.createdAt} <= ${params.before.toISOString()}::timestamptz
      order by ${chatTurnEvals.createdAt}
      limit ${params.limit ?? 500}
    )
    returning ${chatTurnEvals.chatId}
  `);

  return deleted.length;
}

export type UpsertInvestigationResult =
  | { ok: true; id: string; revision: number; created: boolean }
  | { ok: false; error: "not_found" | "context_mismatch" };

/**
 * The revision bump is one statement, so two concurrent commits get two distinct
 * revisions. The chat/project/environment triple is in the `WHERE`: the tenancy check.
 */
export async function upsertInvestigationRevision(
  db: DashboardAgentDbOrTx,
  params: {
    id?: string;
    chatId: string;
    projectRef: string;
    environmentRef: string;
    state: unknown;
  }
): Promise<UpsertInvestigationResult> {
  if (!params.id) {
    const id = generateInvestigationId();
    await db.insert(investigations).values({
      id,
      chatId: params.chatId,
      projectRef: params.projectRef,
      environmentRef: params.environmentRef,
      revision: 0,
      state: params.state,
    });
    return { ok: true, id, revision: 0, created: true };
  }

  const rows = await db
    .update(investigations)
    .set({
      state: params.state,
      revision: sql`${investigations.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(investigations.id, params.id),
        eq(investigations.chatId, params.chatId),
        eq(investigations.projectRef, params.projectRef),
        eq(investigations.environmentRef, params.environmentRef)
      )
    )
    .returning({ id: investigations.id, revision: investigations.revision });

  const updated = rows[0];
  if (updated) {
    return { ok: true, id: updated.id, revision: updated.revision, created: false };
  }

  // Distinguish "no such investigation" from "wrong chat/project/environment".
  const existing = await db
    .select({ id: investigations.id })
    .from(investigations)
    .where(eq(investigations.id, params.id))
    .limit(1);

  return { ok: false, error: existing.length > 0 ? "context_mismatch" : "not_found" };
}

/** Structural: this package stores the transcript, the UI types it. */
export type InvestigationCardMessage = {
  id: string;
  role: "assistant";
  parts: unknown[];
};

export const INVESTIGATION_SETTLEMENT_MESSAGE_ID_PREFIX = "investigation-settlement";

/** Revision-stable, so a retried settle appends the same message instead of a second card. */
export function investigationSettlementMessageId(
  investigationId: string,
  revision: number
): string {
  return `${INVESTIGATION_SETTLEMENT_MESSAGE_ID_PREFIX}:${investigationId}:${revision}`;
}

/**
 * A settled investigation as one more transcript revision. The panel builds the winning
 * revision from `tool-render_view` output blocks and never reads the investigations
 * table, so a settled row nothing appended is still a permanent spinner.
 *
 * Returns null when the state can't be rendered as a card; the caller decides what to
 * do about it, since it must not be silently taken for a closed card.
 */
export function investigationSettlementMessage(params: {
  investigationId: string;
  revision: number;
  state: unknown;
  messageId?: string;
}): InvestigationCardMessage | null {
  const block = investigationBlockSchema.safeParse({
    type: "investigation",
    investigation: params.state,
    id: params.investigationId,
    revision: params.revision,
    version: VIEW_BLOCK_VERSION,
  });
  if (!block.success) return null;

  const id =
    params.messageId ?? investigationSettlementMessageId(params.investigationId, params.revision);
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-render_view",
        toolCallId: id,
        state: "output-available",
        input: { blocks: [{ type: "investigation", investigation: block.data.investigation }] },
        output: { blocks: [block.data] },
      },
    ],
  };
}

export async function getInvestigation(
  db: DashboardAgentDb,
  params: { id: string }
): Promise<Investigation | null> {
  const rows = await db
    .select()
    .from(investigations)
    .where(eq(investigations.id, params.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The wake-to-turn hand-off: the turn revises this row instead of opening a second
 * card. The window keeps an abandoned card from being picked up as this watch's.
 */
export async function findOpenInvestigationForChat(
  db: DashboardAgentDb,
  params: { chatId: string; createdAfter: Date }
): Promise<Investigation | null> {
  const rows = await db
    .select()
    .from(investigations)
    .where(
      and(
        eq(investigations.chatId, params.chatId),
        sql`${investigations.state}->>'outcome' = 'in_progress'`,
        // A string bind: postgres-js won't serialize a Date into a raw fragment.
        sql`${investigations.createdAt} >= ${params.createdAfter.toISOString()}::timestamptz`
      )
    )
    .orderBy(desc(investigations.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listInvestigationsForChat(
  db: DashboardAgentDb,
  params: { chatId: string; limit?: number }
): Promise<Investigation[]> {
  return db
    .select()
    .from(investigations)
    .where(eq(investigations.chatId, params.chatId))
    .orderBy(desc(investigations.updatedAt))
    .limit(params.limit ?? 20);
}

/**
 * Only the newest investigation's outcome counts, which is what `distinct on
 * (chat_id)` picks. Tenancy floor is the join: org, user and not-deleted on the chat.
 */
export async function listChatIdsWithOpenInvestigations(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<Set<string>> {
  const latest = db
    .selectDistinctOn([investigations.chatId], {
      chatId: investigations.chatId,
      outcome: sql<string | null>`${investigations.state}->>'outcome'`.as("outcome"),
    })
    .from(investigations)
    .innerJoin(chats, eq(chats.id, investigations.chatId))
    .where(
      and(
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt)
      )
    )
    .orderBy(investigations.chatId, desc(investigations.updatedAt), desc(investigations.revision))
    .as("latest");

  const rows = await db
    .select({ chatId: latest.chatId })
    .from(latest)
    .where(eq(latest.outcome, "in_progress"));

  return new Set(rows.map((row) => row.chatId));
}

/**
 * Sweep for investigations nothing else settles. `olderThan` is on `updated_at`,
 * which every revision bumps, so a card a live turn is writing to stays out.
 */
export async function listStaleOpenInvestigations(
  db: DashboardAgentDb,
  params: { olderThan: Date; limit?: number }
): Promise<Investigation[]> {
  const rows = await db
    .select({ investigation: investigations })
    .from(investigations)
    .innerJoin(chats, eq(chats.id, investigations.chatId))
    .where(
      and(
        sql`${investigations.state}->>'outcome' = 'in_progress'`,
        isNull(chats.deletedAt),
        // A string bind: postgres-js won't serialize a Date into a raw fragment.
        sql`${investigations.updatedAt} <= ${params.olderThan.toISOString()}::timestamptz`
      )
    )
    .orderBy(investigations.updatedAt)
    .limit(params.limit ?? 100);

  return rows.map((row) => row.investigation);
}

/** What the settle wrote, which is what the closing card has to render. */
export type SettledInvestigation = { id: string; revision: number; state: unknown };

/**
 * Backstop for {@link listStaleOpenInvestigations}. One statement, so a turn that
 * concludes the card first wins — null means it was no longer `in_progress`. The merge
 * mirrors `forceSettledInvestigationState`.
 */
export async function settleInvestigationAsInconclusive(
  db: DashboardAgentDbOrTx,
  params: { id: string; note: string }
): Promise<SettledInvestigation | null> {
  const rows = await db
    .update(investigations)
    .set({
      state: sql`(${investigations.state} - 'progress' - 'remediation') || jsonb_build_object(
        'outcome', 'inconclusive',
        'confidence', 'low',
        'headline', btrim(coalesce(${investigations.state}->>'headline', '') || ' ' || ${params.note})
      )`,
      revision: sql`${investigations.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(investigations.id, params.id),
        sql`${investigations.state}->>'outcome' = 'in_progress'`
      )
    )
    .returning({
      id: investigations.id,
      revision: investigations.revision,
      state: investigations.state,
    });

  return rows[0] ?? null;
}

export type SettledInvestigationCard = { settled: SettledInvestigation; closed: boolean };

/**
 * Settle a stale card and put its closing revision in the transcript, atomically.
 *
 * The two halves cannot be separate operations: a settle that commits without its
 * card leaves a terminal row the stale sweep no longer selects, and the panel — which
 * renders from the transcript — keeps the spinner forever. Rolling back restores the
 * `in_progress` row the sweep already looks for, so the next run retries it.
 *
 * Null when the row was no longer `in_progress`; `closed` is false when that message
 * id is already in the chat.
 */
export async function settleInvestigationAndCloseCard(
  db: DashboardAgentDb,
  params: { id: string; chatId: string; note: string }
): Promise<SettledInvestigationCard | null> {
  return db.transaction(async (tx) => {
    const settled = await settleInvestigationAsInconclusive(tx, params);
    if (!settled) return null;

    const message = investigationSettlementMessage({
      investigationId: settled.id,
      revision: settled.revision,
      state: settled.state,
    });
    // Nothing to deliver means the settle must not stand: a terminal row with no card
    // is the permanent spinner this transaction exists to prevent.
    if (!message) {
      throw new Error(`Investigation ${settled.id} settled to a state that isn't renderable`);
    }

    const closed = await appendChatMessageOnceByChatId(tx, { chatId: params.chatId, message });
    return { settled, closed };
  });
}

export type ClosedInvestigationCard =
  | {
      ok: true;
      id: string;
      revision: number;
      card: InvestigationCardMessage;
      /** False when that message id was already in the chat, so this call wrote nothing. */
      closed: boolean;
    }
  | { ok: false; error: "not_found" | "context_mismatch" | "chat_missing" };

/** The stored message under `messageId`, read from the transcript rather than rebuilt. */
async function storedMessageById(
  tx: DashboardAgentDbOrTx,
  params: { chatId: string; messageId: string }
): Promise<InvestigationCardMessage | null> {
  const rows = await tx
    .select({
      message: sql<InvestigationCardMessage | null>`(
        select message
        from jsonb_array_elements(coalesce(${chats.messages}, '[]'::jsonb)) as message
        where message->>'id' = ${params.messageId}
        limit 1
      )`,
    })
    .from(chats)
    .where(eq(chats.id, params.chatId))
    .limit(1);

  return rows[0]?.message ?? null;
}

/**
 * Same atomicity as {@link settleInvestigationAndCloseCard}, for a caller that brings
 * its own terminal state and its own message id — the consented watch investigation,
 * which dedupes on the action rather than on the revision.
 *
 * Idempotent on that message id, and the locks are what make it so: a redelivered
 * action must not bump the revision, or the row moves ahead of the card the transcript
 * already holds and the panel renders a different revision before and after a refresh.
 * A missing or deleted chat settles nothing — a terminal row with no card is the
 * permanent spinner this transaction exists to prevent.
 *
 * Throwing is the point: the caller's retry only happens if the failure reaches it, and
 * a rolled-back settle leaves the `in_progress` row the stale sweep still selects.
 */
export async function settleInvestigationStateAndCloseCard(
  db: DashboardAgentDb,
  params: {
    id: string;
    chatId: string;
    projectRef: string;
    environmentRef: string;
    state: unknown;
    messageId: string;
  }
): Promise<ClosedInvestigationCard> {
  return db.transaction(async (tx) => {
    // Investigation before chat, the order `persistTurn` and the sweep's
    // `settleInvestigationAndCloseCard` already take. Reversing it here would deadlock
    // against them.
    const investigationRows = await tx
      .select({
        id: investigations.id,
        revision: investigations.revision,
        chatId: investigations.chatId,
        projectRef: investigations.projectRef,
        environmentRef: investigations.environmentRef,
      })
      .from(investigations)
      .where(eq(investigations.id, params.id))
      .limit(1)
      .for("update");

    const investigation = investigationRows[0];
    if (!investigation) return { ok: false, error: "not_found" };
    if (
      investigation.chatId !== params.chatId ||
      investigation.projectRef !== params.projectRef ||
      investigation.environmentRef !== params.environmentRef
    ) {
      return { ok: false, error: "context_mismatch" };
    }

    const chatRows = await tx
      .select({ id: chats.id, deletedAt: chats.deletedAt })
      .from(chats)
      .where(eq(chats.id, params.chatId))
      .limit(1)
      .for("update");

    const chat = chatRows[0];
    if (!chat || chat.deletedAt) return { ok: false, error: "chat_missing" };

    const already = await storedMessageById(tx, {
      chatId: params.chatId,
      messageId: params.messageId,
    });
    if (already) {
      return {
        ok: true,
        id: investigation.id,
        revision: investigation.revision,
        card: already,
        closed: false,
      };
    }

    const result = await upsertInvestigationRevision(tx, {
      id: params.id,
      chatId: params.chatId,
      projectRef: params.projectRef,
      environmentRef: params.environmentRef,
      state: params.state,
    });
    if (!result.ok) return result;

    const card = investigationSettlementMessage({
      investigationId: result.id,
      revision: result.revision,
      state: params.state,
      messageId: params.messageId,
    });
    if (!card) {
      throw new Error(`Investigation ${result.id} settled to a state that isn't renderable`);
    }

    const closed = await appendChatMessageOnceByChatId(tx, {
      chatId: params.chatId,
      message: card,
    });
    if (!closed) {
      throw new Error(`Investigation ${result.id} settled without appending its closing card`);
    }

    return { ok: true, id: result.id, revision: result.revision, card, closed };
  });
}

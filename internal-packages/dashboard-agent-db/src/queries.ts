import { and, desc, eq, ne, sql, isNull } from "drizzle-orm";
import type { DashboardAgentDb } from "./client.js";
import { generateInvestigationId } from "./ids.js";
import {
  chats,
  chatSessions,
  chatTurnEvals,
  investigations,
  type ChatSession,
  type Investigation,
  type NewChatTurnEval,
} from "./schema.js";

/**
 * The access-pattern layer. Every query that touches user data is scoped by
 * `organizationId` and/or `userId` so tenant isolation lives in one place —
 * callers can't forget the `where`. Shared by the agent task and the webapp.
 */

/** Placeholder title for a chat with no generated or user-set title yet. */
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

/**
 * #1 History tab: a user's chats within an org, recent first, pinned on top.
 * Deliberately selects metadata columns only — never `messages` (large blob) or
 * the session token. Covered by `chats_org_user_last_msg_idx`.
 */
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

/**
 * #2 Open a chat: the stored transcript for `useChat`'s initialMessages.
 * Scoped to the owner; returns null if missing/deleted/not theirs.
 */
export async function getChatMessages(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<unknown[] | null> {
  const rows = await db
    .select({ messages: chats.messages })
    .from(chats)
    .where(
      and(eq(chats.id, params.chatId), eq(chats.userId, params.userId), isNull(chats.deletedAt))
    )
    .limit(1);
  return rows[0]?.messages ?? null;
}

/**
 * How many messages this user has SENT across their chats in an org.
 *
 * Counted from the stored transcripts rather than a counter column, so it can't
 * drift from what the user can see in their own history: a deleted chat stops
 * counting, exactly as it stops being readable. Aggregated in Postgres —
 * `messages` blobs are large and the caller only ever wants the number.
 *
 * `excludeChatId` leaves one chat out, for a caller that already has that chat's
 * live message list in hand (the panel counts the open chat client-side, so the
 * turn in flight is included without waiting for it to be persisted).
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

/**
 * #3 Resume the transport on first paint: the session-scoped token + stream
 * cursor. Joins `chats` to scope by owner (chat_sessions has no userId).
 */
export async function getSession(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
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
    .where(and(eq(chatSessions.chatId, params.chatId), eq(chats.userId, params.userId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Owner check: true when a non-deleted chat with this id belongs to the user.
 * Used to authorize chat-scoped actions (e.g. minting a session token) before
 * a session row necessarily exists.
 */
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

/**
 * #4 Create a chat. Idempotent (`onConflictDoNothing`) so the webapp's "new
 * chat" insert and the agent's defensive `onChatStart` ensure can't race into a
 * duplicate-key error.
 */
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

/** The agent's defensive ensure-exists in `onChatStart` / `onPreload`. */
export const ensureChat = createChat;

/** #5 Rename. */
export async function renameChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; title: string }
): Promise<void> {
  await db
    .update(chats)
    .set({ title: params.title, updatedAt: sql`now()` })
    .where(and(eq(chats.id, params.chatId), eq(chats.userId, params.userId)));
}

/**
 * #5 Set an auto-generated title, but only while the chat still has the default
 * title. Conditional on `DEFAULT_CHAT_TITLE` so the background title write can't
 * clobber a user rename, and so it's a safe no-op if it runs more than once.
 */
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

/** #5 Pin / unpin. */
export async function setChatPinned(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; pinned: boolean }
): Promise<void> {
  await db
    .update(chats)
    .set({ pinnedAt: params.pinned ? sql`now()` : null, updatedAt: sql`now()` })
    .where(and(eq(chats.id, params.chatId), eq(chats.userId, params.userId)));
}

/**
 * #5 Mark a chat read up to `at` (default now). Scoped to the owner, so a chatId
 * from a client can only ever clear the caller's own unread state.
 */
export async function markChatRead(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; at?: Date }
): Promise<void> {
  await db
    .update(chats)
    .set({ lastReadAt: params.at ?? sql`now()` })
    .where(and(eq(chats.id, params.chatId), eq(chats.userId, params.userId)));
}

/**
 * #5 Soft-delete a chat. Owner-scoped, so a chatId the caller doesn't own deletes
 * nothing. Returns whether a row was actually deleted.
 */
export async function softDeleteChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<{ deleted: boolean }> {
  const deleted = await db
    .update(chats)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(chats.id, params.chatId), eq(chats.userId, params.userId)))
    .returning({ id: chats.id });

  return { deleted: deleted.length > 0 };
}

/**
 * #6a Persist messages only (agent `onTurnStart` — make the user's message
 * durable in the display copy before the model starts streaming).
 */
export async function persistMessages(
  db: DashboardAgentDb,
  params: { chatId: string; messages: unknown[] }
): Promise<void> {
  await db
    .update(chats)
    .set({ messages: params.messages, lastMessageAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(chats.id, params.chatId));
}

/**
 * #6b Persist a completed turn (agent `onTurnComplete`): the finalized transcript
 * and the refreshed session state, in one transaction. Atomicity matters — on
 * the next page load the frontend reads `messages` and `lastEventId` in parallel;
 * a torn write can resume from a stale cursor and double-render the last turn.
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
  }
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(chats)
      .set({ messages: params.messages, lastMessageAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(chats.id, params.chatId));

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
  });
}

/**
 * #11 Record a turn eval. Idempotent on `(chatId, turn)` so a re-delivered turn
 * (the eval task is triggered with an idempotency key, and may still retry) can
 * never write a second row.
 */
export async function insertTurnEval(db: DashboardAgentDb, row: NewChatTurnEval): Promise<void> {
  await db.insert(chatTurnEvals).values(row).onConflictDoNothing();
}

/* ------------------------------------------------------------------ *
 * Investigations
 * ------------------------------------------------------------------ */

export type UpsertInvestigationResult =
  | { ok: true; id: string; revision: number; created: boolean }
  | { ok: false; error: "not_found" | "context_mismatch" };

/**
 * #12 Commit an investigation revision.
 *
 * Without an `id` this creates the investigation at revision 0 and returns the
 * generated id. With an `id` it bumps the revision — in **one** statement
 * (`SET revision = revision + 1 … RETURNING`), so two concurrent commits produce
 * two distinct, increasing revisions instead of both writing the same number.
 *
 * The chat/project/environment triple is part of the `WHERE`, so a commit carrying
 * the wrong context can never overwrite someone else's investigation: it returns
 * `context_mismatch` and writes nothing.
 */
export async function upsertInvestigationRevision(
  db: DashboardAgentDb,
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

  // Nothing updated: either no such investigation, or it belongs to a different
  // chat/project/environment. Distinguish so the caller can report it properly.
  const existing = await db
    .select({ id: investigations.id })
    .from(investigations)
    .where(eq(investigations.id, params.id))
    .limit(1);

  return { ok: false, error: existing.length > 0 ? "context_mismatch" : "not_found" };
}

/** #12 Load an investigation by id alone (the PK is the whole point). */
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

/** #12 The investigations of a chat, most recently updated first. */
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
 * #12 WHICH chats are mid-investigation — the history list marks those rows.
 *
 * Latest one wins: a chat can hold several investigations, so only the newest
 * one's outcome says whether the chat is still being investigated. `distinct on
 * (chat_id)` picks that row (newest `updated_at`, revision as the tie-break) and
 * the outcome is checked on it — a chat whose old investigation stopped at
 * `in_progress` but has a newer concluded one is NOT investigating.
 *
 * Tenancy floor is the join: org + user + not-deleted on the chat, so nothing
 * outside this user's chats can match.
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

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DashboardAgentDb } from "./client.js";
import {
  chats,
  chatSessions,
  chatTurnEvals,
  type ChatSession,
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

/** #5 Soft-delete. */
export async function softDeleteChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<void> {
  await db
    .update(chats)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(chats.id, params.chatId), eq(chats.userId, params.userId)));
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

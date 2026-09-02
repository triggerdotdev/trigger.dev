import {
  investigationBlockSchema,
  toWellFormedDeep,
  VIEW_BLOCK_VERSION,
  WATCH_REQUEST_MESSAGE_ID_PREFIX,
} from "@internal/dashboard-agent-contracts";
import { and, desc, eq, inArray, ne, notLike, sql, isNull, type SQL } from "drizzle-orm";
import type { DashboardAgentDb } from "./client.js";
import { generateInvestigationId } from "./ids.js";
import { lockChatForWatches, type DashboardAgentDbOrTx } from "./internal.js";
import {
  agentMessageUsage,
  chatMessages,
  chats,
  chatSessions,
  chatTurnEvals,
  investigations,
  watches,
  watchSubmissions,
  type ChatSession,
  type Investigation,
  type NewChatTurnEval,
  type Watch,
} from "./schema.js";
import {
  cancelActiveWatchesForChat,
  settlePendingWatchDeliveriesForChat,
  settlePendingWatchDeliveriesForOrganization,
} from "./watch-queries.js";

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
  /** When the owner last had this chat open. Older than `lastMessageAt` means unread. */
  lastReadAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Never joins the messages or selects the session token. Covered by `chats_org_user_last_msg_idx`.
 *
 * A chat with no messages yet is hidden — an abandoned or failed head-start otherwise leaves a
 * permanent "New chat" in the history. Pinned chats are exempt, in case a chat is ever pinned
 * before it has a message.
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
      lastReadAt: chats.lastReadAt,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      metadata: chats.metadata,
    })
    .from(chats)
    .where(
      and(
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt),
        sql`(${chats.lastMessageAt} is not null or ${chats.pinnedAt} is not null)`
      )
    )
    .orderBy(sql`${chats.pinnedAt} desc nulls last`, desc(chats.lastMessageAt))
    .limit(params.limit ?? 50);
}

/** Null if the chat is missing, deleted, or not this user's; `[]` if it has no messages. */
export async function getChatMessages(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string }
): Promise<unknown[] | null> {
  const rows = await db
    .select({ message: chatMessages.message })
    .from(chatMessages)
    .innerJoin(chats, eq(chats.id, chatMessages.chatId))
    .where(
      and(
        eq(chats.id, params.chatId),
        eq(chats.userId, params.userId),
        eq(chats.organizationId, params.organizationId),
        isNull(chats.deletedAt)
      )
    )
    .orderBy(chatMessages.position);

  if (rows.length > 0) return rows.map((row) => row.message);
  // An empty transcript and a chat this caller can't see look the same until we ask.
  return (await chatExists(db, params)) ? [] : null;
}

/**
 * Counted from the stored messages, not a counter column, so a deleted chat stops
 * counting. `excludeChatId` is for a caller that counts that chat's live messages itself.
 * A watch's consent record is a user message but not a turn the user spent, so it is
 * excluded here and by the client-side count.
 */
export async function countUserMessages(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string; excludeChatId?: string }
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chatMessages)
    .innerJoin(chats, eq(chats.id, chatMessages.chatId))
    .where(
      and(
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt),
        eq(chatMessages.role, "user"),
        notLike(chatMessages.messageId, `${WATCH_REQUEST_MESSAGE_ID_PREFIX}%`),
        params.excludeChatId ? ne(chatMessages.chatId, params.excludeChatId) : undefined
      )
    );
  return rows[0]?.count ?? 0;
}

/**
 * The message count for one org in one billing period. Reads the standalone counter,
 * never the chat rows, so a deleted chat can't lower it within the period. `period` is
 * a UTC calendar month, "YYYY-MM"; the caller chooses it.
 */
export async function getAgentMessageUsage(
  db: DashboardAgentDb,
  params: { organizationId: string; period: string }
): Promise<number> {
  const rows = await db
    .select({ count: agentMessageUsage.count })
    .from(agentMessageUsage)
    .where(
      and(
        eq(agentMessageUsage.organizationId, params.organizationId),
        eq(agentMessageUsage.period, params.period)
      )
    )
    .limit(1);
  return rows[0]?.count ?? 0;
}

/** Bump the counter by one, creating the period row on first use. Returns the new count. */
export async function incrementAgentMessageUsage(
  db: DashboardAgentDb,
  params: { organizationId: string; period: string; by?: number }
): Promise<number> {
  const by = params.by ?? 1;
  const rows = await db
    .insert(agentMessageUsage)
    .values({ organizationId: params.organizationId, period: params.period, count: by })
    .onConflictDoUpdate({
      target: [agentMessageUsage.organizationId, agentMessageUsage.period],
      set: { count: sql`${agentMessageUsage.count} + ${by}`, updatedAt: sql`now()` },
    })
    .returning({ count: agentMessageUsage.count });
  return rows[0]?.count ?? by;
}

/**
 * Chats whose transcript moved on after their owner last looked. A watch wake is one way
 * that happens; an answer that landed while the panel was closed is another, and the panel
 * shows them the same way — a dot on the launcher, the chat lifted and highlighted.
 */
export async function countChatsWithUnreadWork(
  db: DashboardAgentDb,
  /** `excludeChatId` is the chat open on screen: it is being read, so it isn't waiting. */
  params: { organizationId: string; userId: string; excludeChatId?: string }
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chats)
    .where(
      and(
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        params.excludeChatId ? ne(chats.id, params.excludeChatId) : undefined,
        isNull(chats.deletedAt),
        sql`${chats.lastMessageAt} is not null`,
        sql`(${chats.lastReadAt} is null or ${chats.lastMessageAt} > ${chats.lastReadAt})`
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
      metadata: toWellFormedDeep(params.metadata ?? {}),
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
 * Already-deleted rows are skipped, so a retry can't push `deletedAt` forward
 * and move the retention cutoff.
 */
export async function softDeleteChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; organizationId: string }
): Promise<{ deleted: boolean; cancelledWatches: Watch[] }> {
  return db.transaction(async (tx) => {
    // The same lock `createWatch` takes, or a concurrent create lands an active
    // watch on a chat this transaction already deleted.
    await lockChatForWatches(tx, params.chatId);

    const deleted = await tx
      .update(chats)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(chats.id, params.chatId),
          eq(chats.userId, params.userId),
          eq(chats.organizationId, params.organizationId),
          isNull(chats.deletedAt)
        )
      )
      .returning({ id: chats.id });

    if (deleted.length === 0) return { deleted: false, cancelledWatches: [] };

    const cancelledWatches = await cancelActiveWatchesForChat(tx, {
      chatId: params.chatId,
      reason: "chat_deleted",
    });

    // A wake already owed can no longer be delivered into a deleted chat, and an unsettled
    // delivery is exempt from retention: settle it here, or the row is kept until the chat's
    // hard delete (30 days) instead of the much shorter watch retention cutoff.
    await settlePendingWatchDeliveriesForChat(tx, { chatId: params.chatId });

    return { deleted: true, cancelledWatches };
  });
}

/** Enough of the payload to recognise it in an error, without logging a whole transcript. */
// Shape only. A malformed message can carry user text, tool output or source.
function describeMessageShape(message: unknown): string {
  if (!message || typeof message !== "object") return typeof message;
  const keys = Object.keys(message);
  return `object with keys: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}`;
}

/** Row identity. Checked here so a malformed message names itself, not a `NOT NULL` violation. */
function messageIdOf(chatId: string, message: unknown): string {
  const id = (message as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `Chat ${chatId} was handed a message with no id: ${describeMessageShape(message)}`
    );
  }
  return id;
}

/** Lifted out of the payload so the quota count never opens the JSONB. */
function messageRoleOf(chatId: string, message: unknown): string {
  const role = (message as { role?: unknown } | null | undefined)?.role;
  if (typeof role !== "string" || role.length === 0) {
    throw new Error(
      `Chat ${chatId} was handed a message with no role: ${describeMessageShape(message)}`
    );
  }
  return role;
}

/**
 * Reserve `count` contiguous positions on the chat, or null when there is no such chat.
 *
 * One statement, so two writers are handed disjoint ranges and the row lock it takes is
 * held for the rest of this short transaction rather than across a round trip. `scope` is
 * the caller's tenancy check, applied here because this is the statement that has the row.
 */
async function reserveMessagePositions(
  tx: DashboardAgentDbOrTx,
  params: { chatId: string; count: number; scope?: SQL[] }
): Promise<number | null> {
  const rows = await tx
    .update(chats)
    .set({
      nextMessagePosition: sql`${chats.nextMessagePosition} + ${params.count}`,
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(chats.id, params.chatId), isNull(chats.deletedAt), ...(params.scope ?? [])))
    .returning({ next: chats.nextMessagePosition });

  const next = rows[0]?.next;
  return next === undefined ? null : next - params.count;
}

/**
 * Store a batch of messages, insert-only. A message id already in the chat is left exactly
 * as it was recorded — body, position and role — so a stale snapshot cannot overwrite a
 * durable event, and nothing outside `messages` is touched either. Changing a message that
 * is already stored is a different operation: {@link finalizeChatMessage}.
 *
 * `finalizable` is the exception a completing turn needs: the ids it names are rewritten in
 * place through {@link finalizeChatMessage} instead of being skipped, so the transcript ends
 * up with the message the user was shown rather than the mid-flight version of it. Position
 * and id never move. Anything not named — a settlement card, another lane's append — keeps
 * the insert-only guarantee.
 *
 * The batch keeps its incoming order, and a message already stored keeps the position it
 * was first given, which is why a mid-turn append sits before the turn's later messages.
 *
 * The already-stored ids are dropped before any position is reserved, so re-sending a whole
 * snapshot costs one slot per genuinely new message instead of one per message sent.
 */
async function storeChatMessages(
  tx: DashboardAgentDbOrTx,
  params: { chatId: string; messages: unknown[]; finalizable?: ReadonlySet<string> }
): Promise<void> {
  // Every batch write lands here, so this is where a lone surrogate stops before jsonb.
  const deduped = new Map<string, unknown>();
  for (const message of toWellFormedDeep(params.messages)) {
    const id = messageIdOf(params.chatId, message);
    if (deduped.has(id)) {
      throw new Error(`Chat ${params.chatId} was handed message id ${id} twice in one batch`);
    }
    deduped.set(id, message);
  }
  if (deduped.size === 0) return;

  // Hold the chat row before reading which ids are missing, so a concurrent batch can't
  // reserve a slot for a message this one is about to insert.
  const locked = await tx
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, params.chatId), isNull(chats.deletedAt)))
    .limit(1)
    .for("update");
  if (locked.length === 0) return;

  const stored = await tx
    .select({ messageId: chatMessages.messageId })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatId, params.chatId),
        inArray(chatMessages.messageId, [...deduped.keys()])
      )
    );
  for (const row of stored) {
    const message = deduped.get(row.messageId);
    deduped.delete(row.messageId);
    if (message === undefined || !params.finalizable?.has(row.messageId)) continue;
    await finalizeChatMessage(tx, {
      chatId: params.chatId,
      messageId: row.messageId,
      expectedRole: messageRoleOf(params.chatId, message),
      message,
    });
  }
  if (deduped.size === 0) return;

  const start = await reserveMessagePositions(tx, { chatId: params.chatId, count: deduped.size });
  if (start === null) return;

  await tx
    .insert(chatMessages)
    .values(
      [...deduped].map(([messageId, message], offset) => ({
        chatId: params.chatId,
        messageId,
        position: start + offset,
        role: messageRoleOf(params.chatId, message),
        message,
      }))
    )
    .onConflictDoNothing({ target: [chatMessages.chatId, chatMessages.messageId] });
}

/**
 * Rewrite one already-stored message's body, deliberately. The only operation that may
 * change a message the transcript already holds; every other write is insert-only.
 *
 * `expectedRole` is verified rather than updated, on both sides: the stored row's `role`
 * column has to match, and so does the incoming body's own `role`. So the structural
 * column and the payload cannot drift apart, and a finalisation aimed at the wrong
 * message — or at a message some other lane has since replaced — writes nothing and says
 * so by returning false. Position and id are never touched.
 */
export async function finalizeChatMessage(
  db: DashboardAgentDbOrTx,
  params: { chatId: string; messageId: string; expectedRole: string; message: unknown }
): Promise<boolean> {
  const role = messageRoleOf(params.chatId, params.message);
  if (role !== params.expectedRole) {
    throw new Error(
      `Chat ${params.chatId} finalisation of ${params.messageId} expected role ${params.expectedRole} but its body carries ${role}`
    );
  }

  const bodyMessageId = messageIdOf(params.chatId, params.message);
  if (bodyMessageId !== params.messageId) {
    throw new Error(
      `Chat ${params.chatId} finalisation target ${params.messageId} carries body id ${bodyMessageId}`
    );
  }

  const rows = await db
    .update(chatMessages)
    .set({ message: params.message })
    .where(
      and(
        eq(chatMessages.chatId, params.chatId),
        eq(chatMessages.messageId, params.messageId),
        eq(chatMessages.role, params.expectedRole)
      )
    )
    .returning({ messageId: chatMessages.messageId });

  return rows.length > 0;
}

/** No session state, unlike {@link persistTurn}. */
export async function persistMessages(
  db: DashboardAgentDb,
  params: { chatId: string; messages: unknown[] }
): Promise<void> {
  await db.transaction((tx) => storeChatMessages(tx, params));
}

/**
 * Append one message, exactly once. A repeat of the same id writes nothing at all — not
 * the row, not the position, not the chat's timestamps — and says so by returning false.
 *
 * Reserve-and-insert is one statement so a concurrent append can neither take the same
 * position nor be lost, and `on conflict do nothing` is what settles the race two
 * callers that both saw the message missing would otherwise lose.
 */
async function appendOneMessage(
  db: DashboardAgentDbOrTx,
  params: { chatId: string; message: unknown; scope: SQL[] }
): Promise<boolean> {
  // Single-message appends land here — normalize like storeChatMessages.
  const message = toWellFormedDeep(params.message);
  const messageId = messageIdOf(params.chatId, message);
  const rows = await db.execute<{ message_id: string }>(sql`
    with reserved as (
      update ${chats}
      set "next_message_position" = "next_message_position" + 1,
          "last_message_at" = now(),
          "updated_at" = now()
      where "id" = ${params.chatId}
        and "deleted_at" is null
        ${params.scope.length > 0 ? sql`and ${and(...params.scope)}` : sql``}
        and not exists (
          select 1 from ${chatMessages}
          where "chat_id" = ${params.chatId} and "message_id" = ${messageId}
        )
      returning "next_message_position" - 1 as "position"
    )
    insert into ${chatMessages} ("chat_id", "message_id", "position", "role", "message")
    select ${params.chatId}, ${messageId}, reserved."position", ${messageRoleOf(params.chatId, message)},
           ${JSON.stringify(message)}::jsonb
    from reserved
    on conflict ("chat_id", "message_id") do nothing
    returning "message_id"
  `);

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
    message: { id: string; role: string };
  }
): Promise<boolean> {
  return appendOneMessage(db, {
    chatId: params.chatId,
    message: params.message,
    scope: [
      eq(chats.userId, params.userId),
      ...(params.organizationId ? [eq(chats.organizationId, params.organizationId)] : []),
    ],
  });
}

/**
 * Same id-deduped append, for the lanes that have a chat id and no user in context —
 * the between-turns sweep runs on its own, off any session.
 */
export async function appendChatMessageOnceByChatId(
  db: DashboardAgentDbOrTx,
  params: { chatId: string; message: { id: string; role: string } }
): Promise<boolean> {
  return appendOneMessage(db, { chatId: params.chatId, message: params.message, scope: [] });
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
    /**
     * The ids this turn produced. Only these may be rewritten in place — `messages` is the
     * whole replayed transcript, so finalising all of it would let a later turn overwrite a
     * durable event that happens to be in the agent's history.
     */
    finalizeMessageIds?: string[];
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

    // `onTurnStart` stores this turn's messages mid-flight, so their completed bodies arrive
    // here against ids that already exist: without finalisation the transcript would keep the
    // half-finished tool call the user never saw the end of. Everything else — earlier turns,
    // settlement cards, host-appended wakes — stays insert-only.
    // A settlement card is never the turn's to rewrite, however it was named.
    const finalizable = new Set(
      (params.finalizeMessageIds ?? []).filter(
        (id) => !id.startsWith(`${INVESTIGATION_SETTLEMENT_MESSAGE_ID_PREFIX}:`)
      )
    );

    await storeChatMessages(tx, { chatId: params.chatId, messages, finalizable });

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
  await db.insert(chatTurnEvals).values(toWellFormedDeep(row)).onConflictDoNothing();
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

/**
 * Hard-delete a set of chats and every chatId-keyed child row. This DB is FK-free
 * (cross-database in cloud), so the cascade is manual: children first, chats last.
 *
 * The SINGLE place that knows every chatId-keyed table — see the `chats` table
 * comment in schema.ts. Add a new such table here or its rows leak on delete.
 */
async function deleteChatsByIds(tx: DashboardAgentDbOrTx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];

  await tx.delete(chatMessages).where(inArray(chatMessages.chatId, ids));
  await tx.delete(chatSessions).where(inArray(chatSessions.chatId, ids));
  await tx.delete(chatTurnEvals).where(inArray(chatTurnEvals.chatId, ids));
  await tx.delete(investigations).where(inArray(investigations.chatId, ids));
  await tx.delete(watchSubmissions).where(inArray(watchSubmissions.chatId, ids));
  await tx.delete(watches).where(inArray(watches.chatId, ids));

  const deleted = await tx.delete(chats).where(inArray(chats.id, ids)).returning({ id: chats.id });
  return deleted.map((row) => row.id);
}

/**
 * Retention for soft-deleted chats: a bounded batch whose `deleted_at` is past the
 * window is hard-deleted with its children, oldest first, so a backlog drains over
 * several runs. One transaction, so a chat and its child rows go together.
 */
export async function hardDeleteChatsSoftDeletedBefore(
  db: DashboardAgentDb,
  params: { before: Date; limit?: number }
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: chats.id })
      .from(chats)
      .where(
        and(
          sql`${chats.deletedAt} is not null`,
          // A string bind: postgres-js won't serialize a Date into a raw fragment.
          sql`${chats.deletedAt} <= ${params.before.toISOString()}::timestamptz`
        )
      )
      .orderBy(chats.deletedAt)
      .limit(params.limit ?? 500);

    const deleted = await deleteChatsByIds(
      tx,
      rows.map((row) => row.id)
    );
    return deleted.length;
  });
}

/**
 * Soft-delete every one of an organization's chats. The org-deletion path calls this;
 * {@link hardDeleteChatsSoftDeletedBefore} does the eventual hard delete, so no
 * cross-database hard delete runs inside the org-deletion request.
 */
export async function softDeleteChatsForOrganization(
  db: DashboardAgentDb,
  params: { organizationId: string }
): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(chats)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(chats.organizationId, params.organizationId), isNull(chats.deletedAt)))
      .returning({ id: chats.id });

    // Same reason as in `softDeleteChat`: a wake owed to a chat nobody can open again is
    // invisible to both delivery sweeps, and an unsettled delivery is exempt from retention
    // until the chat's hard delete.
    await settlePendingWatchDeliveriesForOrganization(tx, {
      organizationId: params.organizationId,
    });

    return rows.length;
  });
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
  const state = toWellFormedDeep(params.state);
  if (!params.id) {
    const id = generateInvestigationId();
    await db.insert(investigations).values({
      id,
      chatId: params.chatId,
      projectRef: params.projectRef,
      environmentRef: params.environmentRef,
      revision: 0,
      state,
    });
    return { ok: true, id, revision: 0, created: true };
  }

  const rows = await db
    .update(investigations)
    .set({
      state,
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

export type SeedInvestigationResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; error: "context_mismatch" };

/**
 * Open an investigation under an id the caller chose, or report that it is already open.
 *
 * The wake and the investigating lane both call this with the same derived id, so
 * whichever runs first opens the row and the other one finds it. A row under that id in
 * another chat or environment is refused rather than revised.
 */
export async function seedInvestigation(
  db: DashboardAgentDbOrTx,
  params: {
    id: string;
    chatId: string;
    projectRef: string;
    environmentRef: string;
    state: unknown;
  }
): Promise<SeedInvestigationResult> {
  const inserted = await db
    .insert(investigations)
    .values({
      id: params.id,
      chatId: params.chatId,
      projectRef: params.projectRef,
      environmentRef: params.environmentRef,
      revision: 0,
      state: toWellFormedDeep(params.state),
    })
    .onConflictDoNothing({ target: investigations.id })
    .returning({ id: investigations.id });

  if (inserted[0]) return { ok: true, id: inserted[0].id, created: true };

  const rows = await db
    .select({
      id: investigations.id,
      chatId: investigations.chatId,
      projectRef: investigations.projectRef,
      environmentRef: investigations.environmentRef,
    })
    .from(investigations)
    .where(eq(investigations.id, params.id))
    .limit(1);

  const existing = rows[0];
  if (
    !existing ||
    existing.chatId !== params.chatId ||
    existing.projectRef !== params.projectRef ||
    existing.environmentRef !== params.environmentRef
  ) {
    return { ok: false, error: "context_mismatch" };
  }
  return { ok: true, id: existing.id, created: false };
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
 *
 * Order is `last_sweep_attempt_at` nulls first, then `updated_at`: a never-attempted
 * row is always seen before one a prior sweep already failed on, so a row that can't
 * settle rotates to the back instead of pinning the head and starving newer rows.
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
    .orderBy(sql`${investigations.lastSweepAttemptAt} asc nulls first`, investigations.updatedAt)
    .limit(params.limit ?? 100);

  return rows.map((row) => row.investigation);
}

/**
 * Record a failed stale-sweep settle on its own, committed outside the settle tx that
 * rolled back. Bumps the attempt count and stamps `last_sweep_attempt_at` — which does
 * NOT touch `updated_at`, so the row still reads as stale, only later in the order.
 * Returns the new count, or null when the row is no longer `in_progress`.
 */
export async function recordInvestigationSweepAttempt(
  db: DashboardAgentDbOrTx,
  params: { id: string }
): Promise<number | null> {
  const rows = await db
    .update(investigations)
    .set({
      sweepAttempts: sql`${investigations.sweepAttempts} + 1`,
      lastSweepAttemptAt: sql`now()`,
    })
    .where(
      and(
        eq(investigations.id, params.id),
        sql`${investigations.state}->>'outcome' = 'in_progress'`
      )
    )
    .returning({ sweepAttempts: investigations.sweepAttempts });

  return rows[0]?.sweepAttempts ?? null;
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
    .select({ message: chatMessages.message })
    .from(chatMessages)
    .where(
      and(eq(chatMessages.chatId, params.chatId), eq(chatMessages.messageId, params.messageId))
    )
    .limit(1);

  return (rows[0]?.message as InvestigationCardMessage | undefined) ?? null;
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

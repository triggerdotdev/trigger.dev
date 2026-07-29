import { and, desc, eq, inArray, sql, isNull } from "drizzle-orm";
import type { DashboardAgentDb } from "./client.js";
import { generateInvestigationId, generateWatchId } from "./ids.js";
import {
  chats,
  chatSessions,
  chatTurnEvals,
  investigations,
  watches,
  type ChatSession,
  type Investigation,
  type NewChatTurnEval,
  type PersistedWatchSpec,
  type Watch,
  type WatchCancelReason,
  type WatchStatus,
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
 * Tenancy floor is the join, same as {@link listActiveWatchesForChats}: org +
 * user + not-deleted on the chat, so nothing outside this user's chats can match.
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

/* ------------------------------------------------------------------ *
 * Watches
 * ------------------------------------------------------------------ */

/** Guardrail: a chat may hold at most this many watches at once. */
export const MAX_ACTIVE_WATCHES_PER_CHAT = 3;

/** Terminal statuses are immutable — every transition guards on `active`. */
export function isTerminalWatchStatus(status: string): boolean {
  return status === "fired" || status === "expired" || status === "cancelled";
}

export type CreateWatchResult =
  | { ok: true; watch: Watch }
  | { ok: false; error: "limit_reached"; activeCount: number }
  | { ok: false; error: "duplicate"; existingId: string | null };

/** Postgres `unique_violation`. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * #13 Create a watch. The caller supplies the already-resolved identity — both
 * the tenancy snapshot (org/project/env/user, frozen for the watch's life) and
 * the `identity` dedup string for the thing being watched.
 *
 * Two guardrails:
 *
 * - **Dedup** (no second active watch on the same chat/project/environment/identity)
 *   is guaranteed by the partial unique index `watches_chat_active_identity_key`.
 *   The pre-check below exists only to return a friendly result with the existing
 *   watch's id in the common case; a concurrent double-submit slips past it (both
 *   transactions can read no duplicate under READ COMMITTED) and is caught as a
 *   unique violation on insert.
 * - **The ≤`MAX_ACTIVE_WATCHES_PER_CHAT` limit** is best-effort: it's a
 *   read-then-insert, so two simultaneous creates can briefly land a 4th watch.
 *   That's acceptable — watches expire and the next create is rejected, so it
 *   self-corrects. Don't rely on this count being a hard cap.
 */
export async function createWatch(
  db: DashboardAgentDb,
  params: {
    chatId: string;
    identity: string;
    spec: PersistedWatchSpec;
    organizationId: string;
    projectId: string;
    environmentId: string;
    userId: string;
    expiresAt: Date;
    id?: string;
  }
): Promise<CreateWatchResult> {
  try {
    return await db.transaction(async (tx) => {
      const active = await tx
        .select({
          id: watches.id,
          identity: watches.identity,
          projectId: watches.projectId,
          environmentId: watches.environmentId,
        })
        .from(watches)
        .where(and(eq(watches.chatId, params.chatId), eq(watches.status, "active")));

      const duplicate = active.find(
        (w) =>
          w.identity === params.identity &&
          w.projectId === params.projectId &&
          w.environmentId === params.environmentId
      );
      if (duplicate) {
        return { ok: false, error: "duplicate", existingId: duplicate.id };
      }

      if (active.length >= MAX_ACTIVE_WATCHES_PER_CHAT) {
        return { ok: false, error: "limit_reached", activeCount: active.length };
      }

      const rows = await tx
        .insert(watches)
        .values({
          id: params.id ?? generateWatchId(),
          chatId: params.chatId,
          identity: params.identity,
          spec: params.spec,
          organizationId: params.organizationId,
          projectId: params.projectId,
          environmentId: params.environmentId,
          userId: params.userId,
          expiresAt: params.expiresAt,
        })
        .returning();

      return { ok: true, watch: rows[0]! };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the dedup race: the winner is already active. Look it up so the caller
    // can point at the existing watch (null if it went terminal in the meantime).
    const existing = await findActiveWatchByIdentity(db, params);
    return { ok: false, error: "duplicate", existingId: existing?.id ?? null };
  }
}

/**
 * #13 The active watch on a given thing, if any — the dedup lookup behind
 * `createWatch`, also useful on its own ("am I already watching this?").
 * Covered by `watches_chat_active_identity_key`.
 */
export async function findActiveWatchByIdentity(
  db: DashboardAgentDb,
  params: { chatId: string; projectId: string; environmentId: string; identity: string }
): Promise<Watch | null> {
  const rows = await db
    .select()
    .from(watches)
    .where(
      and(
        eq(watches.chatId, params.chatId),
        eq(watches.projectId, params.projectId),
        eq(watches.environmentId, params.environmentId),
        eq(watches.identity, params.identity),
        eq(watches.status, "active")
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** #13 Load a watch by id. */
export async function getWatch(
  db: DashboardAgentDb,
  params: { id: string }
): Promise<Watch | null> {
  const rows = await db.select().from(watches).where(eq(watches.id, params.id)).limit(1);
  return rows[0] ?? null;
}

/**
 * #13 The chat's active watches — what the UI shows and what the guardrail
 * counts. Covered by the partial `watches_chat_active_idx`.
 */
export async function listActiveWatchesForChat(
  db: DashboardAgentDb,
  params: { chatId: string }
): Promise<Watch[]> {
  return db
    .select()
    .from(watches)
    .where(and(eq(watches.chatId, params.chatId), eq(watches.status, "active")))
    .orderBy(desc(watches.createdAt));
}

/** One active watch of a chat, in the shape the chip row needs. */
export interface ActiveWatchSummary {
  id: string;
  chatId: string;
  identity: string;
  status: WatchStatus;
  kind: string;
  note: string;
  checkEveryMinutes: number;
  expiresAt: Date;
}

/**
 * #13 Active watches for MANY chats in one query, keyed by chatId — the history
 * list renders up to 50 chats and must not fan out a query per row.
 *
 * Tenancy floor is the join, not the caller: the chats are re-scoped by
 * `organizationId` + `userId` + not-deleted here, so a chat id from anywhere
 * (including a client) can only ever match a chat this user owns.
 */
export async function listActiveWatchesForChats(
  db: DashboardAgentDb,
  params: { chatIds: string[]; organizationId: string; userId: string }
): Promise<Record<string, ActiveWatchSummary[]>> {
  if (params.chatIds.length === 0) return {};

  const rows = await db
    .select({
      id: watches.id,
      chatId: watches.chatId,
      identity: watches.identity,
      status: watches.status,
      spec: watches.spec,
      expiresAt: watches.expiresAt,
    })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        inArray(watches.chatId, params.chatIds),
        eq(watches.status, "active"),
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt)
      )
    )
    .orderBy(desc(watches.createdAt));

  const byChat: Record<string, ActiveWatchSummary[]> = {};
  for (const row of rows) {
    (byChat[row.chatId] ??= []).push({
      id: row.id,
      chatId: row.chatId,
      identity: row.identity,
      status: row.status,
      kind: row.spec.kind,
      note: row.spec.note,
      checkEveryMinutes: row.spec.checkEveryMinutes,
      expiresAt: row.expiresAt,
    });
  }
  return byChat;
}

/**
 * #13 How many watch wakes this user hasn't seen — what the launcher's dot shows
 * while the panel is closed.
 *
 * A wake is a watch that resolved (`fired` or `expired`; a cancelled watch is
 * never narrated) after the chat was last read. `last_read_at is null` means the
 * chat was never opened since the column existed, so every wake in it is unread.
 * The resolution time is `fired_at` for a fire and `last_checked_at` for an
 * expiry — `transitionWatchCondition` writes both in the same statement.
 *
 * Tenancy floor is the join, same as `listActiveWatchesForChats`: org + user +
 * not-deleted on the chat, so nothing outside this user's chats can be counted.
 */
export async function countUnreadWatchWakes(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        inArray(watches.status, ["fired", "expired"]),
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt),
        sql`(${chats.lastReadAt} is null or coalesce(${watches.firedAt}, ${watches.lastCheckedAt}) > ${chats.lastReadAt})`
      )
    );
  return rows[0]?.count ?? 0;
}

/** An unread wake, as the dashboard toast narrates it. */
export interface UnreadWatchWake {
  watchId: string;
  chatId: string;
  outcome: "fired" | "expired";
  /** The watch's note, or its identity when the note is blank. */
  note: string;
  /** When the watch resolved: `fired_at` for a fire, `last_checked_at` for an expiry. */
  firedAt: Date;
}

// The toast fires one per wake, so a long-unopened panel doesn't need the whole
// backlog — enough to name the recent ones, and the count carries the rest.
const UNREAD_WAKE_LIST_LIMIT = 10;

/**
 * #13 The unread wakes themselves, newest first — what the dashboard toast reads
 * from. Same wake definition and tenancy floor as {@link countUnreadWatchWakes};
 * this one returns rows instead of a total, capped at
 * {@link UNREAD_WAKE_LIST_LIMIT}.
 */
export async function listUnreadWatchWakes(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<UnreadWatchWake[]> {
  const resolvedAt = sql<Date>`coalesce(${watches.firedAt}, ${watches.lastCheckedAt})`;

  const rows = await db
    .select({
      watchId: watches.id,
      chatId: watches.chatId,
      status: watches.status,
      identity: watches.identity,
      spec: watches.spec,
      resolvedAt,
    })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        inArray(watches.status, ["fired", "expired"]),
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt),
        sql`(${chats.lastReadAt} is null or coalesce(${watches.firedAt}, ${watches.lastCheckedAt}) > ${chats.lastReadAt})`
      )
    )
    .orderBy(desc(resolvedAt))
    .limit(UNREAD_WAKE_LIST_LIMIT);

  return rows.map((row) => ({
    watchId: row.watchId,
    chatId: row.chatId,
    // Narrowed by the `in` clause above; only these two statuses are wakes.
    outcome: row.status as "fired" | "expired",
    note: row.spec.note?.trim() || row.identity,
    firedAt: new Date(row.resolvedAt),
  }));
}

/**
 * #13 WHICH chats have unread wakes — the history list sorts them first and
 * highlights them. Same wake definition and tenancy floor as
 * {@link countUnreadWatchWakes}; this one groups instead of totalling.
 *
 * Not scoped to the listed chat ids: the set is small (only chats with a
 * resolved, unseen watch) and the caller is listing every chat the user owns
 * anyway, so a second `in` clause would only narrow what the join already does.
 */
export async function listChatIdsWithUnreadWakes(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ chatId: watches.chatId })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        inArray(watches.status, ["fired", "expired"]),
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt),
        sql`(${chats.lastReadAt} is null or coalesce(${watches.firedAt}, ${watches.lastCheckedAt}) > ${chats.lastReadAt})`
      )
    );
  return new Set(rows.map((row) => row.chatId));
}

/** A chat's org plus the project/environment context stored on it. */
export interface ChatWatchContext {
  organizationId: string;
  projectRef?: string;
  environmentId?: string;
}

/**
 * #13 Ownership check AND context read in one query: a live chat with this id
 * owned by this user, plus the project/environment its turns ran in.
 *
 * The agent's `schedule_watch` tool posts only `{ spec, chatId }` — its delegated
 * token carries a userId and nothing else — so the environment comes from the
 * chat's own stored context rather than from the request. It is still only a
 * CLAIM: the caller re-authorizes the resolved environment for this user before
 * anything is created, so the worst a stale or wrong context can do is fail.
 *
 * `metadata.context` is the clientData snapshot the panel stored when the chat was
 * created.
 */
export async function getChatWatchContext(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<ChatWatchContext | null> {
  const rows = await db
    .select({ organizationId: chats.organizationId, metadata: chats.metadata })
    .from(chats)
    .where(
      and(eq(chats.id, params.chatId), eq(chats.userId, params.userId), isNull(chats.deletedAt))
    )
    .limit(1);

  const chat = rows[0];
  if (!chat) return null;

  const context = (chat.metadata as { context?: Record<string, unknown> } | null)?.context;
  const projectRef = typeof context?.projectRef === "string" ? context.projectRef : undefined;
  const environmentId =
    typeof context?.environmentId === "string" ? context.environmentId : undefined;

  return { organizationId: chat.organizationId, projectRef, environmentId };
}

/**
 * #13 The watch's condition resolved: it fired, or it ran out of time. Atomic —
 * only an `active` row transitions, so a check that fires at the same moment the
 * sweeper expires the watch yields exactly one winner (the loser gets `null`).
 * Both outcomes notify, so `deliveryStatus` becomes `pending`.
 */
export async function transitionWatchCondition(
  db: DashboardAgentDb,
  params: {
    id: string;
    status: "fired" | "expired";
    lastResult?: Record<string, unknown> | null;
  }
): Promise<Watch | null> {
  const rows = await db
    .update(watches)
    .set({
      status: params.status,
      deliveryStatus: "pending",
      lastCheckedAt: sql`now()`,
      firedAt: params.status === "fired" ? sql`now()` : null,
      ...(params.lastResult !== undefined ? { lastResult: params.lastResult } : {}),
    })
    .where(and(eq(watches.id, params.id), eq(watches.status, "active")))
    .returning();
  return rows[0] ?? null;
}

/**
 * #13 Cancel an active watch. Cancellation is never notified, so `deliveryStatus`
 * stays `not_required`. Atomic guard on `active`: a watch that already fired keeps
 * its outcome (and its pending notification) and this is a no-op returning `null`.
 */
export async function cancelWatch(
  db: DashboardAgentDb,
  params: { id: string; reason: WatchCancelReason }
): Promise<Watch | null> {
  const rows = await db
    .update(watches)
    .set({
      status: "cancelled",
      cancelReason: params.reason,
      cancelledAt: sql`now()`,
      deliveryStatus: "not_required",
    })
    .where(and(eq(watches.id, params.id), eq(watches.status, "active")))
    .returning();
  return rows[0] ?? null;
}

/**
 * #13 Cancel every active watch of a chat — chat deletion, or the user losing
 * access to the project the watches were created against.
 */
export async function cancelActiveWatchesForChat(
  db: DashboardAgentDb,
  params: { chatId: string; reason: WatchCancelReason }
): Promise<Watch[]> {
  return db
    .update(watches)
    .set({
      status: "cancelled",
      cancelReason: params.reason,
      cancelledAt: sql`now()`,
      deliveryStatus: "not_required",
    })
    .where(and(eq(watches.chatId, params.chatId), eq(watches.status, "active")))
    .returning();
}

/**
 * #13 The outcome notification went out. Guarded on `pending` so a retried
 * delivery can't send twice or reset `deliveredAt`.
 */
export async function markWatchDelivered(
  db: DashboardAgentDb,
  params: { id: string }
): Promise<Watch | null> {
  const rows = await db
    .update(watches)
    .set({ deliveryStatus: "delivered", deliveredAt: sql`now()` })
    .where(and(eq(watches.id, params.id), eq(watches.deliveryStatus, "pending")))
    .returning();
  return rows[0] ?? null;
}

/**
 * #13 A check ran and the condition didn't resolve. Increments `tickCount` in the
 * same statement and returns it, so the caller can build the next check's
 * idempotency key (`watch:{id}:tick:{n}`) from a value no concurrent tick shares.
 * Guarded on `active` — a terminal watch is never ticked again.
 */
export async function recordWatchTick(
  db: DashboardAgentDb,
  params: {
    id: string;
    lastResult?: Record<string, unknown> | null;
    /** Set the counter explicitly; by default it's incremented by one. */
    tickCount?: number;
    /** Override the check timestamp; defaults to `now()`. */
    lastCheckedAt?: Date;
  }
): Promise<{ tickCount: number; lastCheckedAt: Date | null } | null> {
  const rows = await db
    .update(watches)
    .set({
      lastCheckedAt: params.lastCheckedAt ?? sql`now()`,
      tickCount: params.tickCount ?? sql`${watches.tickCount} + 1`,
      ...(params.lastResult !== undefined ? { lastResult: params.lastResult } : {}),
    })
    .where(and(eq(watches.id, params.id), eq(watches.status, "active")))
    .returning({ tickCount: watches.tickCount, lastCheckedAt: watches.lastCheckedAt });
  return rows[0] ?? null;
}

/**
 * #13 Sweep: active watches whose deadline has passed, oldest first. Callers
 * expire these via `transitionWatchCondition(id, { status: "expired" })`.
 * Covered by `watches_status_expires_idx`.
 */
export async function listExpiredActiveWatches(
  db: DashboardAgentDb,
  params: { now?: Date; limit?: number } = {}
): Promise<Watch[]> {
  return db
    .select()
    .from(watches)
    .where(
      and(
        eq(watches.status, "active"),
        params.now ? sql`${watches.expiresAt} <= ${params.now}` : sql`${watches.expiresAt} <= now()`
      )
    )
    .orderBy(watches.expiresAt)
    .limit(params.limit ?? 100);
}

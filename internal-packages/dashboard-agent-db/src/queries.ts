import { and, desc, eq, inArray, ne, sql, isNull } from "drizzle-orm";
import {
  watchResolutionToWireStatus,
  type WatchObservedOutcome,
  type WatchResolution,
} from "@internal/dashboard-agent-contracts";
import type { DashboardAgentDb } from "./client.js";
import { generateInvestigationId, generateWatchDeliveryClaimId, generateWatchId } from "./ids.js";
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

/**
 * The db handle or an already-open transaction, for the queries that are also
 * called as one step of a larger atomic write.
 */
type DashboardAgentDbOrTx =
  | DashboardAgentDb
  | Parameters<Parameters<DashboardAgentDb["transaction"]>[0]>[0];

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
 * Advisory-lock namespace for the per-chat watch lock — ASCII `watc`, so the
 * (namespace, hashtext(chatId)) pair can't collide with another lock's key space.
 */
const WATCH_CHAT_LOCK_NAMESPACE = 0x77617463;

/**
 * Serialize everything that decides "may this chat have this watch?" — creating a
 * watch and deleting the chat under it. Transaction-scoped, so it is held to
 * commit and released by Postgres whatever happens.
 */
function lockChatForWatches(tx: DashboardAgentDbOrTx, chatId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(${WATCH_CHAT_LOCK_NAMESPACE}, hashtext(${chatId}))`
  );
}

/**
 * #5 Soft-delete a chat AND end its watches, in one transaction.
 *
 * The two halves must not be separable: a deleted chat has nowhere to deliver a
 * watch outcome, so a crash between them would leave live watches ticking against
 * a conversation the user can no longer see. Owner-scoped, so a chatId the caller
 * doesn't own deletes nothing and cancels nothing.
 */
export async function softDeleteChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<{ deleted: boolean; cancelledWatches: Watch[] }> {
  return db.transaction(async (tx) => {
    // The SAME lock `createWatch` takes. Without it a create that resolved a live
    // chat can commit its insert after this transaction cancelled the chat's
    // watches, leaving an active watch on a deleted chat.
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
 * Append ONE message to a chat's transcript, atomically.
 *
 * This is the deterministic-append seam: the watch card's confirmation and its
 * one-shot result block are host-decided facts, not model output, so they are
 * written straight onto the transcript with no turn and no LLM. `||` on the JSONB
 * column is a single statement, so it cannot lose a concurrent turn's write the
 * way a read-modify-write from the app would.
 *
 * Owner-scoped and live-chat-scoped: a chatId the caller doesn't own appends
 * nothing and returns false, so ownership never has to be re-proved by the caller
 * after the fact.
 */
export async function appendChatMessage(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; message: unknown }
): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({
      messages: sql`coalesce(${chats.messages}, '[]'::jsonb) || ${JSON.stringify([params.message])}::jsonb`,
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(eq(chats.id, params.chatId), eq(chats.userId, params.userId), isNull(chats.deletedAt))
    )
    .returning({ id: chats.id });

  return rows.length > 0;
}

/**
 * `appendChatMessage`, but idempotent on the message's `id`: a message the
 * transcript already holds is not appended again. The wake narration writes
 * through this — its deliverer retries, and each retry re-appends blindly with
 * plain `||`.
 */
export async function appendChatMessageOnce(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string; message: { id: string } }
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
        isNull(chats.deletedAt),
        sql`not exists (select 1 from jsonb_array_elements(coalesce(${chats.messages}, '[]'::jsonb)) m where m->>'id' = ${params.message.id})`
      )
    )
    .returning({ id: chats.id });

  return rows.length > 0;
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

/**
 * A wake that still has to reach its chat: never claimed, or claimed by a
 * deliverer that hasn't marked it delivered (yet, or ever). Whether the claim is
 * still someone's to hold is {@link claimWatchDelivery}'s call, not this one's.
 */
export function isWatchDeliveryOwed(status: string): boolean {
  return status === "pending" || status === "delivering";
}

export type CreateWatchResult =
  | { ok: true; watch: Watch }
  | { ok: false; error: "limit_reached"; activeCount: number }
  | { ok: false; error: "duplicate"; existingId: string | null }
  /** The chat is gone (or was deleted while this create was in flight). */
  | { ok: false; error: "chat_not_found" };

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
 * - **The ≤`MAX_ACTIVE_WATCHES_PER_CHAT` limit** is a hard cap: the count and the
 *   insert are one transaction, serialized per chat by a transaction-scoped
 *   advisory lock, so concurrent creates queue behind each other and the one that
 *   would be the 4th is rejected instead of landing.
 *
 * The same lock also serializes against `softDeleteChat`, and the chat is re-read
 * inside it, so a create can never land an active watch on a chat that was deleted
 * while the create was in flight.
 */
export async function createWatch(
  db: DashboardAgentDb,
  params: {
    chatId: string;
    identity: string;
    spec: PersistedWatchSpec;
    organizationId: string;
    projectId: string;
    /** The project's external `proj_…` ref — what a wake scopes an investigation by. */
    projectRef?: string | null;
    environmentId: string;
    userId: string;
    expiresAt: Date;
    /** Consent, given at creation, to investigate after an attention outcome. */
    investigateOnAttention?: boolean;
    id?: string;
  }
): Promise<CreateWatchResult> {
  try {
    return await db.transaction(async (tx) => {
      // Serialize this chat's watch decisions, so count-then-insert is atomic
      // against a concurrent create AND against the chat being deleted underneath.
      await lockChatForWatches(tx, params.chatId);

      // Re-read the chat under the lock. A delete that committed while this call
      // was validating its target would otherwise be overtaken by the insert
      // below, leaving an active watch on a conversation the user has deleted.
      const chat = await tx
        .select({ id: chats.id })
        .from(chats)
        .where(and(eq(chats.id, params.chatId), isNull(chats.deletedAt)))
        .limit(1);
      if (chat.length === 0) return { ok: false, error: "chat_not_found" } as const;

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
          projectRef: params.projectRef ?? null,
          environmentId: params.environmentId,
          userId: params.userId,
          expiresAt: params.expiresAt,
          investigateOnAttention: params.investigateOnAttention ?? false,
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
 * The guardrails, BEFORE anything is written — the `cap → dedup → immediate
 * check` order of §4.4.
 *
 * Under the resolution model the immediate check can answer the request outright
 * (a one-shot result block, no watch row at all), so the cap and the dedup have to
 * be consulted before it runs: refusing at the 4th watch, or pointing at the watch
 * that already covers this, must not depend on whether the condition happens to be
 * true right now.
 *
 * Advisory only. It is a plain read, so it is NOT race-proof — {@link createWatch}
 * re-applies both guardrails atomically under the per-chat lock and the partial
 * unique index, and remains the authority. This exists so the common case gets the
 * friendly answer without a row being written first.
 */
export async function precheckWatchCreation(
  db: DashboardAgentDb,
  params: { chatId: string; projectId: string; environmentId: string; identity: string }
): Promise<
  | { ok: true }
  | { ok: false; error: "limit_reached"; activeCount: number }
  | { ok: false; error: "duplicate"; existingId: string }
> {
  const active = await db
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
  if (duplicate) return { ok: false, error: "duplicate", existingId: duplicate.id };

  if (active.length >= MAX_ACTIVE_WATCHES_PER_CHAT) {
    return { ok: false, error: "limit_reached", activeCount: active.length };
  }

  return { ok: true };
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
  /** The last check's reason — lets a resolved banner tell "can no longer
   *  happen" (terminal_unsatisfied) apart from a plain timeout. */
  endedReason: string | null;
  /** How it ended. NULL while active and for every cancellation. */
  resolution: WatchResolution | null;
  /** What the resolving check observed — the other half of the headline. */
  observedOutcome: WatchObservedOutcome | null;
}

/**
 * #13 Watches for MANY chats in one query, keyed by chatId — the history list
 * renders up to 50 chats and must not fan out a query per row.
 *
 * Returns every non-cancelled watch, not only the active ones: the chips
 * filter to `active` client-side, while the wake banner needs the KIND of a
 * watch that has already fired to pick its tone.
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
      lastResult: watches.lastResult,
      resolution: watches.resolution,
      observedOutcome: watches.observedOutcome,
    })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        inArray(watches.chatId, params.chatIds),
        inArray(watches.status, ["active", "fired", "expired"]),
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
      endedReason: typeof row.lastResult?.reason === "string" ? row.lastResult.reason : null,
      resolution: row.resolution,
      observedOutcome: row.observedOutcome,
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
        // Only a DELIVERED wake is a wake the user can open: between the terminal
        // transition and the append to the chat there is no message to read yet,
        // so signalling it would point at an empty conversation.
        eq(watches.deliveryStatus, "delivered"),
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
  /**
   * The three fields a surface needs to state the FACT rather than "Watch update"
   * (§5.3): the kind and identity name the thing, the resolution and the observed
   * outcome decide what happened to it. Frozen on the row by the resolving check,
   * so the toast and the banner can never disagree.
   */
  kind: string;
  identity: string;
  /** Null on a row written before the resolution model — the surface falls back. */
  resolution: WatchResolution | null;
  observedOutcome: WatchObservedOutcome | null;
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
      resolution: watches.resolution,
      observedOutcome: watches.observedOutcome,
      resolvedAt,
    })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        inArray(watches.status, ["fired", "expired"]),
        // Only a DELIVERED wake is a wake the user can open: between the terminal
        // transition and the append to the chat there is no message to read yet,
        // so signalling it would point at an empty conversation.
        eq(watches.deliveryStatus, "delivered"),
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
    kind: row.spec.kind,
    identity: row.identity,
    resolution: row.resolution,
    observedOutcome: row.observedOutcome,
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
        // Only a DELIVERED wake is a wake the user can open: between the terminal
        // transition and the append to the chat there is no message to read yet,
        // so signalling it would point at an empty conversation.
        eq(watches.deliveryStatus, "delivered"),
        eq(chats.organizationId, params.organizationId),
        eq(chats.userId, params.userId),
        isNull(chats.deletedAt),
        sql`(${chats.lastReadAt} is null or coalesce(${watches.firedAt}, ${watches.lastCheckedAt}) > ${chats.lastReadAt})`
      )
    );
  return new Set(rows.map((row) => row.chatId));
}

/** The tenancy a chat belongs to. */
export interface ChatWatchContext {
  organizationId: string;
}

/**
 * #13 Ownership check for a chat, returning the org it belongs to: a live chat
 * with this id owned by this user.
 *
 * Deliberately does NOT return a project/environment. The chat's stored
 * `metadata.context` is a snapshot from chat creation, and a watch must be bound
 * to the environment of the turn that asked for it — which comes from the
 * authenticated request context, not from the row. The org is returned because it
 * is immutable for a chat and is the tenancy floor its watches can't leave.
 */
export async function getChatWatchContext(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<ChatWatchContext | null> {
  const rows = await db
    .select({ organizationId: chats.organizationId })
    .from(chats)
    .where(
      and(eq(chats.id, params.chatId), eq(chats.userId, params.userId), isNull(chats.deletedAt))
    )
    .limit(1);

  const chat = rows[0];
  if (!chat) return null;

  return { organizationId: chat.organizationId };
}

/**
 * #13 The watch RESOLVED. Atomic — only an `active` row transitions, so a check
 * that resolves at the same moment the sweeper completes the window yields
 * exactly one winner (the loser gets `null`). Every resolution notifies, so
 * `deliveryStatus` becomes `pending`.
 *
 * One statement writes all three halves of the answer — the `resolution`, the
 * `observedOutcome`, and the frozen `lastResult` facts. That atomicity is what
 * lets §7.5 hold: delivery never re-reads the source to reconstruct what
 * happened, so a retry cannot rebuild a different headline, and banner, toast,
 * email and narration all share one set of facts.
 *
 * `status` is derived, never passed: it is the two-value WIRE encoding of the
 * resolution (§7.5 binding), so no caller can put a status on the row that
 * disagrees with the resolution it recorded.
 */
export async function transitionWatchCondition(
  db: DashboardAgentDb,
  params: {
    id: string;
    resolution: WatchResolution;
    observedOutcome?: WatchObservedOutcome | null;
    lastResult?: Record<string, unknown> | null;
  }
): Promise<Watch | null> {
  const status = watchResolutionToWireStatus(params.resolution);
  const rows = await db
    .update(watches)
    .set({
      status,
      resolution: params.resolution,
      deliveryStatus: "pending",
      lastCheckedAt: sql`now()`,
      firedAt: status === "fired" ? sql`now()` : null,
      ...(params.observedOutcome !== undefined ? { observedOutcome: params.observedOutcome } : {}),
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
  db: DashboardAgentDbOrTx,
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
 * How long a `delivering` claim is respected before the wake is considered
 * abandoned and may be claimed again. Longer than a delivery takes (seconds), so
 * the only rows it releases are ones whose deliverer really died.
 */
export const WATCH_DELIVERY_CLAIM_STALE_MS = 5 * 60 * 1000;

/** A delivery claim: the row as claimed, plus the token that owns the claim. */
export interface WatchDeliveryClaim {
  watch: Watch;
  /**
   * The fencing token. {@link releaseWatchDelivery} and {@link markWatchDelivered}
   * only act while the row still carries it, so a claim that has been taken over
   * can't be released or completed by its previous owner.
   */
  claimId: string;
}

/**
 * #13 Claim the right to deliver a resolved watch's wake — the atomic gate that
 * makes "exactly one wake" true even with two deliverers running at once.
 *
 * A stable action id dedups a wake only through a read-then-write on the
 * transcript, which two concurrent appends can interleave through. So the claim
 * lives here instead: `pending → delivering` in one statement, and only the row it
 * returns may append. The loser gets `null` and delivers nothing.
 *
 * A claim is not a lease that has to be renewed: {@link releaseWatchDelivery}
 * hands it back when the append fails, and a claim left behind by a deliverer that
 * died is re-claimable once it is older than `staleBefore` — otherwise a crash
 * between the claim and `markWatchDelivered` would strand the wake forever.
 *
 * Every claim writes a NEW `deliveryClaimId`, which is what makes the takeover
 * safe: the status alone can't say WHOSE claim is in the row, so a deliverer that
 * hung past the stale window and then woke up would otherwise release (or complete)
 * the claim that replaced it, and a third deliverer would append in parallel with
 * the second. The token is required by both of those writes, so the old owner's
 * calls are no-ops.
 */
export async function claimWatchDelivery(
  db: DashboardAgentDb,
  params: { id: string; staleBefore: Date }
): Promise<WatchDeliveryClaim | null> {
  const claimId = generateWatchDeliveryClaimId();
  const rows = await db
    .update(watches)
    .set({ deliveryStatus: "delivering", deliveryClaimedAt: sql`now()`, deliveryClaimId: claimId })
    .where(
      and(
        eq(watches.id, params.id),
        sql`(${watches.deliveryStatus} = 'pending' or (${watches.deliveryStatus} = 'delivering' and coalesce(${watches.deliveryClaimedAt}, ${watches.createdAt}) <= ${params.staleBefore.toISOString()}::timestamptz))`
      )
    )
    .returning();
  const watch = rows[0];
  return watch ? { watch, claimId } : null;
}

/**
 * #13 Give a delivery claim back, after an append that failed: the wake is owed
 * again, so the invocation's own retry (or another deliverer) can pick it up
 * without waiting out the stale window.
 *
 * Fenced on `claimId`: only the deliverer that still holds the claim releases it,
 * so a late release from a taken-over owner can't hand somebody else's in-flight
 * claim back to `pending`. Guarded on `delivering` too, so it can never un-deliver
 * a wake that landed.
 */
export async function releaseWatchDelivery(
  db: DashboardAgentDb,
  params: { id: string; claimId: string }
): Promise<Watch | null> {
  const rows = await db
    .update(watches)
    .set({ deliveryStatus: "pending", deliveryClaimedAt: null, deliveryClaimId: null })
    .where(
      and(
        eq(watches.id, params.id),
        eq(watches.deliveryClaimId, params.claimId),
        eq(watches.deliveryStatus, "delivering")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * #13 The outcome notification went out, so the row is closed out.
 *
 * Two callers, two guards:
 *
 * - A deliverer that claimed the wake passes its `claimId`, and the mark lands only
 *   while the row still carries that claim. A stale takeover replaced the token, so
 *   the old owner's late mark can't complete the new owner's delivery.
 * - The one path that never claims (an outcome resolved inline with nothing to
 *   narrate later) passes no `claimId` and marks a `pending` row. Deliberately not
 *   `delivering`: an unfenced mark must not be able to finish a claim it doesn't own.
 *
 * Either way a repeat is a no-op, so a retried delivery can't reset `deliveredAt`.
 */
export async function markWatchDelivered(
  db: DashboardAgentDb,
  params: { id: string; claimId?: string }
): Promise<Watch | null> {
  const rows = await db
    .update(watches)
    .set({ deliveryStatus: "delivered", deliveredAt: sql`now()` })
    .where(
      and(
        eq(watches.id, params.id),
        params.claimId
          ? and(
              eq(watches.deliveryClaimId, params.claimId),
              eq(watches.deliveryStatus, "delivering")
            )
          : eq(watches.deliveryStatus, "pending")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * #13 Claim a tick GENERATION for a watch — the one and only writer of
 * `tickCount`.
 *
 * A tick invocation carries its generation in its payload and claims it here. The
 * claim is resumable: it lands when the row is still on the previous generation (a
 * fresh tick) OR already on this one (a retry of the invocation that owns this
 * generation, which crashed somewhere mid-tick). It does NOT land when the row is
 * further ahead — the successor generation already ran, so this invocation is a
 * late duplicate with nothing left to do, and gets `null`.
 *
 * Resuming is what keeps a crash from killing the chain. The generation lives in
 * the payload and the successor's idempotency key (`watch:{id}:tick:{n+1}`) is a
 * pure function of it, so re-running a whole generation is safe: the successor
 * trigger dedups on that key, the check record is an overwrite, the terminal
 * transition is guarded on `active`, and the wake dedups on its action id. A claim
 * that refused to resume would leave the chain with nobody to schedule the next
 * generation, and the watch would sit active and unchecked until its deadline.
 *
 * Guarded on `active` too: a terminal watch is never ticked again.
 *
 * Deliberately does NOT touch `lastCheckedAt`: claiming a generation is not an
 * observation, and a claim whose check then failed to run would otherwise date the
 * watch's last observation to it — the expiry narration reports that timestamp as
 * "last observed". `lastCheckedAt` is written only where a result is written with
 * it ({@link recordWatchCheck}, {@link transitionWatchCondition}), so the timestamp
 * and the observation it belongs to always agree.
 */
export async function claimWatchTick(
  db: DashboardAgentDb,
  params: { id: string; generation: number }
): Promise<Watch | null> {
  const rows = await db
    .update(watches)
    .set({ tickCount: params.generation })
    .where(
      and(
        eq(watches.id, params.id),
        eq(watches.status, "active"),
        inArray(watches.tickCount, [params.generation - 1, params.generation])
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * #13 Record what a check observed: `lastCheckedAt` plus the `lastResult` the
 * notification reads. Deliberately does NOT touch `tickCount` — the generation is
 * claimed by {@link claimWatchTick} alone, so the counter has a single writer and
 * this can be called by both the check endpoint and the tick without either of
 * them advancing the chain. Guarded on `active`, so a concurrent fire/expire wins
 * and this no-ops.
 */
export async function recordWatchCheck(
  db: DashboardAgentDb,
  params: {
    id: string;
    lastResult?: Record<string, unknown> | null;
    /** Override the check timestamp; defaults to `now()`. */
    lastCheckedAt?: Date;
  }
): Promise<{ tickCount: number; lastCheckedAt: Date | null } | null> {
  const rows = await db
    .update(watches)
    .set({
      lastCheckedAt: params.lastCheckedAt ?? sql`now()`,
      ...(params.lastResult !== undefined ? { lastResult: params.lastResult } : {}),
    })
    .where(and(eq(watches.id, params.id), eq(watches.status, "active")))
    .returning({ tickCount: watches.tickCount, lastCheckedAt: watches.lastCheckedAt });
  return rows[0] ?? null;
}

/**
 * #13 Sweep: terminal watches whose delivery is still owed.
 *
 * The other half of the backstop, and the one `listExpiredActiveWatches` cannot
 * see: a row that has already been resolved (so it is no longer `active`) but
 * whose wake never landed — the session append failed, the run that owned it died
 * between the transition and the append, or the outcome was resolved inline and
 * the turn that was going to narrate it never finished. Without this the row sits
 * `pending` forever, and the wake is simply lost.
 *
 * `olderThan` is a grace window on the resolution time (`fired_at` for a fire,
 * `last_checked_at` for an expiry): the normal delivery happens within seconds, so
 * only rows that have been owed for a while are recovered, and the recovery can't
 * race the path that is still mid-delivery.
 *
 * A row mid-delivery (`delivering`) is owed too, but only once its claim is older
 * than the same window: that is a deliverer that died between claiming the wake and
 * marking it delivered, and nothing else would ever pick it up.
 *
 * Deleted chats are excluded — there is nowhere to deliver a wake in a
 * conversation the user can no longer open (deleting a chat cancels its active
 * watches, so this only ever skips one that resolved just before the delete).
 */
export async function listWatchesAwaitingDelivery(
  db: DashboardAgentDb,
  params: { olderThan: Date; limit?: number }
): Promise<Watch[]> {
  const olderThan = sql`${params.olderThan.toISOString()}::timestamptz`;
  const rows = await db
    .select({ watch: watches })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        inArray(watches.status, ["fired", "expired"]),
        sql`(${watches.deliveryStatus} = 'pending' or (${watches.deliveryStatus} = 'delivering' and coalesce(${watches.deliveryClaimedAt}, ${watches.createdAt}) <= ${olderThan}))`,
        isNull(chats.deletedAt),
        sql`coalesce(${watches.firedAt}, ${watches.lastCheckedAt}) <= ${olderThan}`
      )
    )
    .orderBy(sql`coalesce(${watches.firedAt}, ${watches.lastCheckedAt})`)
    .limit(params.limit ?? 100);

  return rows.map((row) => row.watch);
}

/**
 * #13 Sweep: active watches whose deadline has passed, oldest first. Callers run
 * the final boundary evaluation and resolve these via
 * `transitionWatchCondition` — which may still be `condition_met` (§7.4).
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
        // The bind has to be a string: postgres-js won't serialize a Date into a
        // raw `sql` fragment (it silently worked only while nobody passed `now`).
        params.now
          ? sql`${watches.expiresAt} <= ${params.now.toISOString()}::timestamptz`
          : sql`${watches.expiresAt} <= now()`
      )
    )
    .orderBy(watches.expiresAt)
    .limit(params.limit ?? 100);
}

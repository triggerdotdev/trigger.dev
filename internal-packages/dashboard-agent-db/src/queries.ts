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
  watchBatches,
  watches,
  type ChatSession,
  type Investigation,
  type NewChatTurnEval,
  type PersistedWatchSpec,
  type Watch,
  type WatchBatch,
  type WatchCancelReason,
  type WatchStatus,
} from "./schema.js";

/**
 * The access-pattern layer. Every query that touches user data is scoped by
 * `organizationId` and/or `userId`, so tenant isolation lives in one place.
 */

export const DEFAULT_CHAT_TITLE = "New chat";

/** The db handle or an already-open transaction, for queries used inside a larger write. */
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
 * A user's chats within an org, recent first, pinned on top. Selects metadata
 * columns only, never `messages` (large blob) or the session token. Covered by
 * `chats_org_user_last_msg_idx`.
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

/** The stored transcript. Scoped to the owner; null if missing, deleted or not theirs. */
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
 * How many messages this user has sent across their chats in an org.
 *
 * Counted from the stored transcripts rather than a counter column, so it can't
 * drift from what the user sees in their history: a deleted chat stops counting.
 * Aggregated in Postgres because `messages` blobs are large.
 *
 * `excludeChatId` leaves one chat out, for a caller that already counts that
 * chat's live messages itself.
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
 * The session-scoped token and stream cursor. Joins `chats` to scope by owner,
 * because `chat_sessions` has no `userId`.
 */
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

/**
 * Owner check. Authorizes chat-scoped actions such as minting a session token,
 * before a session row necessarily exists.
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
 * Create a chat. Idempotent, so the webapp's insert and the agent's
 * ensure-exists can't race into a duplicate-key error.
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

/**
 * Set an auto-generated title, only while the chat still has the default one, so
 * the background title write can't clobber a user rename and is safe to repeat.
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

/**
 * Mark a chat read up to `at` (default now). Owner-scoped, so a chatId from a
 * client can only clear the caller's own unread state.
 */
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
 * Advisory-lock namespace for the per-chat watch lock (ASCII `watc`), so the
 * (namespace, hashtext(chatId)) pair can't collide with another lock's key space.
 */
const WATCH_CHAT_LOCK_NAMESPACE = 0x77617463;

/**
 * Serializes creating a watch against deleting the chat under it.
 * Transaction-scoped, so Postgres releases it whatever happens.
 */
function lockChatForWatches(tx: DashboardAgentDbOrTx, chatId: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(${WATCH_CHAT_LOCK_NAMESPACE}, hashtext(${chatId}))`
  );
}

/**
 * Soft-delete a chat and end its watches, in one transaction.
 *
 * The two halves must not be separable: a deleted chat has nowhere to deliver a
 * watch outcome, so a crash between them would leave live watches ticking against
 * a conversation the user can no longer see. Owner-scoped.
 */
export async function softDeleteChat(
  db: DashboardAgentDb,
  params: { chatId: string; userId: string }
): Promise<{ deleted: boolean; cancelledWatches: Watch[] }> {
  return db.transaction(async (tx) => {
    // The same lock `createWatch` takes. Without it a create that resolved a live
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

/** Persist messages only, so the user's message is durable before the model streams. */
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
 * Append one message to a chat's transcript, atomically.
 *
 * For host-decided facts that are not model output, written straight onto the
 * transcript with no turn. `||` on the JSONB column is a single statement, so it
 * cannot lose a concurrent turn's write the way a read-modify-write would.
 *
 * Owner-scoped and live-chat-scoped: a chatId the caller doesn't own appends
 * nothing and returns false.
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
 * `appendChatMessage`, but idempotent on the message's `id`. The wake narration
 * writes through this, because its deliverer retries and plain `||` would
 * re-append on every retry.
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
 * Persist a completed turn: the finalized transcript and the refreshed session
 * state, in one transaction. The frontend reads `messages` and `lastEventId` in
 * parallel on load, so a torn write resumes from a stale cursor and double-renders
 * the last turn.
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
 * Record a turn eval. Idempotent on `(chatId, turn)`, so a retried eval task can
 * never write a second row.
 */
export async function insertTurnEval(db: DashboardAgentDb, row: NewChatTurnEval): Promise<void> {
  await db.insert(chatTurnEvals).values(row).onConflictDoNothing();
}

// Investigations

export type UpsertInvestigationResult =
  | { ok: true; id: string; revision: number; created: boolean }
  | { ok: false; error: "not_found" | "context_mismatch" };

/**
 * Commit an investigation revision. Without an `id` it creates the investigation
 * at revision 0; with an `id` it bumps the revision in one statement, so two
 * concurrent commits produce two distinct revisions instead of the same number.
 *
 * The chat/project/environment triple is part of the `WHERE`, so a commit carrying
 * the wrong context returns `context_mismatch` and writes nothing.
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

/** Load an investigation by id alone. */
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
 * The freshest `in_progress` investigation of a chat, within a recent window.
 *
 * The hand-off for a consented watch investigation: the wake seeds the card and
 * the turn that follows revises that row rather than opening a second one. The
 * window keeps an old abandoned card, one the stale sweep hasn't reached yet, from
 * being picked up as this watch's.
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

/** The investigations of a chat, most recently updated first. */
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
 * Which chats are mid-investigation.
 *
 * A chat can hold several investigations, so only the newest one's outcome counts.
 * `distinct on (chat_id)` picks that row (newest `updated_at`, revision as the
 * tie-break): a chat whose old investigation stopped at `in_progress` but has a
 * newer concluded one is not investigating.
 *
 * Tenancy floor is the join: org, user and not-deleted on the chat, so nothing
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

/**
 * Sweep: investigations still `in_progress` long after any turn could be working
 * on them, oldest first. Two rows nothing else settles: a turn that died before its
 * own settle ran, and a card opened for a later turn that never came. The caller
 * settles these to `inconclusive` so the user isn't left with a spinner.
 *
 * `olderThan` is on `updated_at`, which every revision bumps, so a card a live turn
 * is still writing to keeps moving out of the window. Deleted chats are excluded.
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

/**
 * Settle one investigation as `inconclusive`, the backstop for
 * {@link listStaleOpenInvestigations}. False if the row was no longer `in_progress`.
 *
 * One statement, so it can't fight a live revision: a turn that concludes the card
 * first wins and this updates nothing. The state is rewritten in SQL rather than
 * read-modify-written for the same reason.
 *
 * The merge mirrors the agent's `forceSettledInvestigationState`: `progress` and
 * `remediation` are dropped, because the schema rejects a fix on an inconclusive
 * card; confidence falls to `low` and `note` is appended to the headline.
 */
export async function settleInvestigationAsInconclusive(
  db: DashboardAgentDb,
  params: { id: string; note: string }
): Promise<boolean> {
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
    .returning({ id: investigations.id });

  return rows.length > 0;
}

// Watches

/** Guardrail: a chat may hold at most this many watches at once. */
export const MAX_ACTIVE_WATCHES_PER_CHAT = 3;

/** Terminal statuses are immutable. Every transition guards on `active`. */
export function isTerminalWatchStatus(status: string): boolean {
  return status === "fired" || status === "expired" || status === "cancelled";
}

/**
 * A wake that still has to reach its chat: never claimed, or claimed by a deliverer
 * that hasn't marked it delivered. Whether the claim is still someone's to hold is
 * {@link claimWatchDelivery}'s call.
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
 * Create a watch. The caller supplies the already-resolved identity: the tenancy
 * snapshot, frozen for the watch's life, and the `identity` dedup string.
 *
 * Dedup is guaranteed by the partial unique index
 * `watches_chat_active_identity_key`. The pre-check below only returns a friendly
 * result with the existing watch's id; a concurrent double-submit slips past it
 * under READ COMMITTED and is caught as a unique violation on insert.
 *
 * The `MAX_ACTIVE_WATCHES_PER_CHAT` cap holds because the count and the insert are
 * one transaction, serialized per chat by the advisory lock. That same lock
 * serializes against `softDeleteChat`, and the chat is re-read inside it, so a
 * create can't land an active watch on a chat deleted while it was in flight.
 */
export async function createWatch(
  db: DashboardAgentDb,
  params: {
    chatId: string;
    identity: string;
    spec: PersistedWatchSpec;
    organizationId: string;
    projectId: string;
    /** The project's external `proj_…` ref, which a wake scopes an investigation by. */
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
      // against a concurrent create and against the chat being deleted underneath.
      await lockChatForWatches(tx, params.chatId);

      // Re-read the chat under the lock. A delete that committed while this call
      // was validating its target would otherwise be overtaken by the insert
      // below, leaving an active watch on a deleted conversation.
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
 * The guardrails before anything is written, in `cap` then `dedup` order.
 *
 * The immediate check can answer a watch request outright with no watch row, so the
 * cap and the dedup are consulted before it runs: refusing at the 4th watch, or
 * pointing at the watch that already covers this, must not depend on whether the
 * condition happens to be true right now.
 *
 * Advisory only, and a plain read, so it is not race-proof. {@link createWatch}
 * re-applies both guardrails atomically and remains the authority.
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
 * The active watch on a given thing, if any. Covered by
 * `watches_chat_active_identity_key`.
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

/** Load a watch by id. */
export async function getWatch(
  db: DashboardAgentDb,
  params: { id: string }
): Promise<Watch | null> {
  const rows = await db.select().from(watches).where(eq(watches.id, params.id)).limit(1);
  return rows[0] ?? null;
}

/**
 * The chat's active watches. Covered by the partial
 * `watches_chat_active_identity_key`, which leads with `chat_id`.
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
  /**
   * The last check's reason. Lets a resolved banner tell `terminal_unsatisfied`
   * apart from a plain timeout.
   */
  endedReason: string | null;
  /** How it ended. NULL while active and for every cancellation. */
  resolution: WatchResolution | null;
  /** What the resolving check observed. */
  observedOutcome: WatchObservedOutcome | null;
}

/**
 * Watches for many chats in one query, keyed by chatId, because the history list
 * renders up to 50 chats and must not fan out a query per row.
 *
 * Returns every non-cancelled watch, not only the active ones: the chips filter to
 * `active` client-side, while the wake banner needs the kind of an already-fired
 * watch to pick its tone.
 *
 * Tenancy floor is the join, not the caller: the chats are re-scoped by
 * `organizationId`, `userId` and not-deleted here, so a chat id from anywhere can
 * only match a chat this user owns.
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

/** When the watch resolved: `fired_at` for a fire, `last_checked_at` for an expiry. */
const wakeResolvedAt = sql<Date>`coalesce(${watches.firedAt}, ${watches.lastCheckedAt})`;

/** The wake landed after the chat was last read. Never-read chats count as unread. */
const unreadWake = sql`(${chats.lastReadAt} is null or ${wakeResolvedAt} > ${chats.lastReadAt})`;

/**
 * A wake the user can open: a resolved, delivered watch in one of this user's live
 * chats. Shared by the three wake queries so they can't drift apart.
 *
 * Only a delivered wake counts, because between the terminal transition and the
 * append to the chat there is no message to read yet.
 *
 * Org and user are asserted on the watch row as well as on the joined chat. Not a
 * second tenancy rule (the watch snapshots the chat's owner at creation, so the two
 * can't disagree) but so `watches_org_user_wake_idx` narrows to this user before
 * the join runs.
 */
function deliveredWakeScope(params: { organizationId: string; userId: string }) {
  return [
    inArray(watches.status, ["fired", "expired"]),
    eq(watches.deliveryStatus, "delivered"),
    eq(watches.organizationId, params.organizationId),
    eq(watches.userId, params.userId),
    eq(chats.organizationId, params.organizationId),
    eq(chats.userId, params.userId),
    isNull(chats.deletedAt),
  ];
}

/**
 * How many watch wakes this user hasn't seen. A wake is a watch that resolved
 * (`fired` or `expired`; a cancelled watch is never narrated) after the chat was
 * last read, and `last_read_at is null` counts every wake in the chat as unread.
 * Scoping is {@link deliveredWakeScope}.
 */
export async function countUnreadWatchWakes(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(and(...deliveredWakeScope(params), unreadWake));
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
   * The kind and identity name the thing; the resolution and the observed outcome
   * say what happened to it. Frozen on the row by the resolving check, so the toast
   * and the banner can never disagree.
   */
  kind: string;
  identity: string;
  /** Null on a row written before the resolution model. The surface falls back. */
  resolution: WatchResolution | null;
  observedOutcome: WatchObservedOutcome | null;
  /** Landed after the chat's read marker. The dot counts these; the toast fires either way. */
  unread: boolean;
}

// The toast fires one per wake, so a long-unopened panel doesn't need the whole
// backlog. The count carries the rest.
const UNREAD_WAKE_LIST_LIMIT = 10;

/**
 * The unread wakes themselves, newest first. Same wake definition and scoping as
 * {@link countUnreadWatchWakes}, capped at {@link UNREAD_WAKE_LIST_LIMIT}.
 */
export async function listRecentWatchWakes(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string; deliveredAfter: Date }
): Promise<UnreadWatchWake[]> {
  const rows = await db
    .select({
      watchId: watches.id,
      chatId: watches.chatId,
      status: watches.status,
      identity: watches.identity,
      spec: watches.spec,
      resolution: watches.resolution,
      observedOutcome: watches.observedOutcome,
      resolvedAt: wakeResolvedAt,
      // The toast fires once per wake whether or not it was read; only the dot cares.
      unread: sql<boolean>`${unreadWake}`,
    })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        ...deliveredWakeScope(params),
        sql`${wakeResolvedAt} > ${params.deliveredAfter.toISOString()}::timestamptz`
      )
    )
    .orderBy(desc(wakeResolvedAt))
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
    unread: row.unread,
  }));
}

/**
 * Which chats have unread wakes. Same wake definition and scoping as
 * {@link countUnreadWatchWakes}, grouped instead of totalled.
 *
 * Not scoped to the listed chat ids: the set is small and the caller is listing
 * every chat the user owns anyway, so a second `in` clause would only narrow what
 * the join already does.
 */
export async function listChatIdsWithUnreadWakes(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ chatId: watches.chatId })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(and(...deliveredWakeScope(params), unreadWake));
  return new Set(rows.map((row) => row.chatId));
}

/** The tenancy a chat belongs to. */
export interface ChatWatchContext {
  organizationId: string;
}

/**
 * Ownership check for a chat, returning the org it belongs to.
 *
 * Deliberately does not return a project or environment. The chat's stored
 * `metadata.context` is a snapshot from chat creation, and a watch must be bound to
 * the environment of the turn that asked for it, which comes from the authenticated
 * request context. The org is immutable for a chat and is the tenancy floor its
 * watches can't leave.
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
 * The watch resolved. Only an `active` row transitions, so a check that resolves at
 * the same moment the sweeper completes the window yields exactly one winner; the
 * loser gets `null`. Every resolution notifies, so `deliveryStatus` becomes
 * `pending`.
 *
 * One statement writes the `resolution`, the `observedOutcome` and the frozen
 * `lastResult`. Delivery never re-reads the source to reconstruct what happened, so
 * a retry cannot rebuild a different headline and banner, toast, email and
 * narration all share one set of facts.
 *
 * `status` is derived, never passed: it is the two-value wire encoding of the
 * resolution, so no caller can put a status on the row that disagrees with it.
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
 * Cancel an active watch. Cancellation is never notified, so `deliveryStatus` stays
 * `not_required`. Guarded on `active`, so a watch that already fired keeps its
 * outcome and its pending notification, and this returns `null`.
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
 * Cancel every active watch of a chat: chat deletion, or the user losing access to
 * the project the watches were created against.
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
 * How long a `delivering` claim is respected before the wake is considered abandoned
 * and may be claimed again. Much longer than a delivery takes, so the only rows it
 * releases are ones whose deliverer died.
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
 * Claim the right to deliver a resolved watch's wake. The gate that keeps "exactly
 * one wake" true with two deliverers running at once: `pending` to `delivering` in
 * one statement, and only the row it returns may append. A stable action id would
 * not be enough, because dedup on the transcript is a read-then-write two concurrent
 * appends can interleave through.
 *
 * A claim is not a renewed lease. {@link releaseWatchDelivery} hands it back when the
 * append fails, and a claim left behind by a dead deliverer is re-claimable once it
 * is older than `staleBefore`, so a crash between the claim and
 * `markWatchDelivered` can't strand the wake forever.
 *
 * Every claim writes a new `deliveryClaimId`, which is what makes takeover safe: the
 * status alone can't say whose claim is in the row, so a deliverer that hung past the
 * stale window would otherwise release or complete the claim that replaced it. Both
 * of those writes require the token, so the old owner's calls are no-ops.
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
 * Give a delivery claim back after a failed append, so a retry can pick the wake up
 * without waiting out the stale window.
 *
 * Fenced on `claimId`, so a late release from a taken-over owner can't hand somebody
 * else's in-flight claim back to `pending`. Guarded on `delivering` too, so it can
 * never un-deliver a wake that landed.
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
 * The outcome notification went out, so the row is closed out. Two callers, two
 * guards:
 *
 * - A deliverer that claimed the wake passes its `claimId`, and the mark lands only
 *   while the row still carries that claim, so a taken-over owner's late mark can't
 *   complete the new owner's delivery.
 * - The one path that never claims (an outcome resolved inline with nothing to
 *   narrate later) passes no `claimId` and marks a `pending` row. Not `delivering`,
 *   because an unfenced mark must not finish a claim it doesn't own.
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
 * Claim a tick generation for a watch. The only writer of `tickCount`.
 *
 * The claim is resumable: it lands when the row is still on the previous generation
 * (a fresh tick) or already on this one (a retry of the invocation that owns the
 * generation and crashed mid-tick). It does not land when the row is further ahead,
 * because the successor already ran and this is a late duplicate.
 *
 * Resuming is what keeps a crash from killing the chain. Re-running a whole
 * generation is safe: the successor's idempotency key (`watch:{id}:tick:{n+1}`) is a
 * pure function of the generation, the check record is an overwrite, the terminal
 * transition is guarded on `active`, and the wake dedups on its action id. A claim
 * that refused to resume would leave nobody to schedule the next generation, and the
 * watch would sit active and unchecked until its deadline.
 *
 * Guarded on `active`, so a terminal watch is never ticked again.
 *
 * Deliberately does not touch `lastCheckedAt`: claiming a generation is not an
 * observation, and the expiry narration reports that timestamp as "last observed".
 * It is written only where a result is written with it ({@link recordWatchCheck},
 * {@link transitionWatchCondition}).
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
 * Record what a check observed: `lastCheckedAt` plus the `lastResult` the
 * notification reads. Deliberately does not touch `tickCount`, so the counter keeps
 * {@link claimWatchTick} as its single writer and both the check endpoint and the
 * tick can call this without advancing the chain. Guarded on `active`, so a
 * concurrent fire or expire wins and this no-ops.
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
 * Sweep: terminal watches whose delivery is still owed. The half of the backstop
 * `listExpiredActiveWatches` cannot see, because the row is already resolved. Without
 * it a row whose append failed sits `pending` forever and the wake is lost.
 *
 * `olderThan` is a grace window on the resolution time (`fired_at` for a fire,
 * `last_checked_at` for an expiry), so the recovery can't race a path that is still
 * mid-delivery. A `delivering` row is owed only once its claim is older than the same
 * window, which means its deliverer died and nothing else would pick it up.
 *
 * Deleted chats are excluded. Deleting a chat cancels its active watches, so this
 * only skips one that resolved just before the delete.
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
 * Sweep: drop watches that ended long enough ago that nothing reads them again.
 * After its wake has landed a terminal watch is immutable and unread (dedup only
 * considers `active` rows, and the wake's facts are frozen into the transcript), so
 * the row is pure retention.
 *
 * Guarded three ways in one statement: terminal only, delivery settled so a row
 * that still owes a wake is never deleted out from under the delivery sweep, and the
 * age measured from the last thing that happened to the row (`greatest(...)`,
 * falling back to the never-null `created_at`), so a late delivery restarts the
 * clock rather than shortening it.
 *
 * Bounded per run, and deliberately unordered: which eligible rows go first doesn't
 * matter, and without a sort Postgres can stop as soon as it has a batch.
 *
 * Only `watches` rows. Chats, messages and investigations are the user's history.
 */
export async function deleteTerminalWatchesOlderThan(
  db: DashboardAgentDb,
  params: { before: Date; limit?: number }
): Promise<number> {
  const eligible = db
    .select({ id: watches.id })
    .from(watches)
    .where(
      and(
        inArray(watches.status, ["fired", "expired", "cancelled"]),
        inArray(watches.deliveryStatus, ["not_required", "delivered"]),
        sql`greatest(${watches.deliveredAt}, ${watches.cancelledAt}, ${watches.firedAt}, ${watches.lastCheckedAt}, ${watches.createdAt}) <= ${params.before.toISOString()}::timestamptz`
      )
    )
    .limit(params.limit ?? 500);

  const deleted = await db
    .delete(watches)
    .where(inArray(watches.id, eligible))
    .returning({ id: watches.id });

  return deleted.length;
}

/**
 * Sweep: active watches whose deadline has passed, oldest first. Callers run the
 * final boundary evaluation and resolve these via `transitionWatchCondition`, which
 * may still be `condition_met`. Covered by `watches_status_expires_idx`.
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
        // A string bind: postgres-js won't serialize a Date into a raw fragment.
        params.now
          ? sql`${watches.expiresAt} <= ${params.now.toISOString()}::timestamptz`
          : sql`${watches.expiresAt} <= now()`
      )
    )
    .orderBy(watches.expiresAt)
    .limit(params.limit ?? 100);
}

// Batch chains: one polling loop per (environment, cadence), not one per watch.

/**
 * The cadence a watch asks to be checked at, read out of its spec JSONB. Cheap,
 * because every query that uses it is already narrowed to one environment's `active`
 * rows by `watches_active_env_idx`.
 */
const watchCadenceMinutes = sql<number>`(${watches.spec} ->> 'checkEveryMinutes')::int`;

/**
 * How many active watches one batch tick takes at a time. Well past what an
 * environment realistically holds, and the soonest-deadline-first order means a group
 * over the cap never defers a watch about to reach its window boundary.
 */
const BATCH_GROUP_LIMIT = 500;

/**
 * Every `active` watch of one (environment, cadence) group, in one read. This is what
 * replaces N per-watch tick runs with one: the caller authorizes the environment
 * once, loads the shared expensive data once, and evaluates these rows against it.
 *
 * Which of them are due is the caller's decision, because it depends on the tick's
 * own clock and the caller has to see the whole group anyway to know whether the
 * chain should tick again.
 */
export async function listActiveWatchesForBatch(
  db: DashboardAgentDb,
  params: { environmentId: string; cadenceMinutes: number; limit?: number }
): Promise<Watch[]> {
  return db
    .select()
    .from(watches)
    .where(
      and(
        eq(watches.status, "active"),
        eq(watches.environmentId, params.environmentId),
        sql`${watchCadenceMinutes} = ${params.cadenceMinutes}`
      )
    )
    .orderBy(watches.expiresAt)
    .limit(params.limit ?? BATCH_GROUP_LIMIT);
}

/**
 * The wakes one group still owes: the batch's half of the delivery backstop.
 *
 * A retried batch run would never see a watch that went terminal mid-run, because it
 * is no longer in the group's `active` set. This is what it sees instead, which keeps
 * recovery at seconds rather than waiting out the webapp sweep's grace window.
 *
 * No grace window here on purpose: the retry is meant to be immediate, and two
 * deliverers racing is already settled by the fenced delivery claim. A mid-delivery
 * row is owed only once its claim is stale.
 *
 * Deleted chats are excluded.
 */
export async function listWatchesAwaitingDeliveryForBatch(
  db: DashboardAgentDb,
  params: {
    environmentId: string;
    cadenceMinutes: number;
    claimStaleBefore: Date;
    limit?: number;
  }
): Promise<Watch[]> {
  const rows = await db
    .select({ watch: watches })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        eq(watches.environmentId, params.environmentId),
        sql`${watchCadenceMinutes} = ${params.cadenceMinutes}`,
        inArray(watches.status, ["fired", "expired"]),
        sql`(${watches.deliveryStatus} = 'pending' or (${watches.deliveryStatus} = 'delivering' and coalesce(${watches.deliveryClaimedAt}, ${watches.createdAt}) <= ${params.claimStaleBefore.toISOString()}::timestamptz))`,
        isNull(chats.deletedAt)
      )
    )
    .orderBy(sql`coalesce(${watches.firedAt}, ${watches.lastCheckedAt})`)
    .limit(params.limit ?? 100);

  return rows.map((row) => row.watch);
}

/**
 * Arm the batch chain for one (environment, cadence) group. The gate that keeps a
 * group to exactly one polling loop.
 *
 * Returns the row when this call armed the chain, so the caller must trigger the run
 * that owns `epoch` / `generation + 1`. Returns `null` when a live chain already
 * covers the group, and a watch created into it joins the next tick.
 *
 * One statement, so two creations racing on the same group can only produce one
 * chain. The `DO UPDATE … WHERE` is the guard: an existing row is re-armed only if
 * its chain has stopped or its heartbeat is older than `staleBefore`, meaning the run
 * that owned it died.
 *
 * `epoch` is bumped on every arm and `generation` reset with it, which is what makes
 * re-arming a dead chain safe: the zombie's next claim names the old epoch and lands
 * nowhere, and the two epochs' successor idempotency keys can never collide.
 */
export async function armWatchBatch(
  db: DashboardAgentDb,
  params: { environmentId: string; cadenceMinutes: number; staleBefore: Date }
): Promise<WatchBatch | null> {
  const rows = await db
    .insert(watchBatches)
    .values({
      environmentId: params.environmentId,
      cadenceMinutes: params.cadenceMinutes,
      epoch: 1,
      generation: 0,
      status: "running",
    })
    .onConflictDoUpdate({
      target: [watchBatches.environmentId, watchBatches.cadenceMinutes],
      set: {
        epoch: sql`${watchBatches.epoch} + 1`,
        generation: 0,
        status: "running",
        armedAt: sql`now()`,
        lastTickAt: null,
      },
      setWhere: sql`(${watchBatches.status} = 'stopped' or coalesce(${watchBatches.lastTickAt}, ${watchBatches.armedAt}) <= ${params.staleBefore.toISOString()}::timestamptz)`,
    })
    .returning();
  return rows[0] ?? null;
}

/**
 * Claim a batch chain's tick generation. The batch-level twin of
 * {@link claimWatchTick}, with the same resumable rule plus the epoch fence: it
 * refuses on an epoch mismatch, which is how a zombie chain from before a re-arm
 * exits instead of ticking alongside its replacement.
 *
 * Also the heartbeat. `lastTickAt` is what the re-arm backstop reads to tell a live
 * chain from one whose run died.
 */
export async function claimWatchBatchTick(
  db: DashboardAgentDb,
  params: {
    environmentId: string;
    cadenceMinutes: number;
    epoch: number;
    generation: number;
  }
): Promise<WatchBatch | null> {
  const rows = await db
    .update(watchBatches)
    .set({ generation: params.generation, lastTickAt: sql`now()` })
    .where(
      and(
        eq(watchBatches.environmentId, params.environmentId),
        eq(watchBatches.cadenceMinutes, params.cadenceMinutes),
        eq(watchBatches.epoch, params.epoch),
        eq(watchBatches.status, "running"),
        inArray(watchBatches.generation, [params.generation - 1, params.generation])
      )
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Stop a batch chain: the group has no active watches left, or the run that was going
 * to own the chain couldn't be triggered.
 *
 * Fenced on the epoch, so a stop decided by one epoch's run can never end the chain a
 * later arm started. A stopped row is re-armed with a fresh epoch the moment a watch
 * needs the group polled again.
 */
export async function stopWatchBatch(
  db: DashboardAgentDb,
  params: { environmentId: string; cadenceMinutes: number; epoch: number }
): Promise<WatchBatch | null> {
  const rows = await db
    .update(watchBatches)
    .set({ status: "stopped" })
    .where(
      and(
        eq(watchBatches.environmentId, params.environmentId),
        eq(watchBatches.cadenceMinutes, params.cadenceMinutes),
        eq(watchBatches.epoch, params.epoch),
        eq(watchBatches.status, "running")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** A (environment, cadence) group that needs a chain. */
export interface WatchBatchGroup {
  environmentId: string;
  cadenceMinutes: number;
}

/**
 * How long a chain may go without a heartbeat before it counts as dead, over the
 * group's own cadence: three cadences plus two minutes. Longer than a tick's jitter
 * and retries, short enough that a one-minute group whose run died polls again within
 * minutes.
 *
 * `watchBatchStaleMs` applies the same formula in TypeScript, so this listing and the
 * guard inside {@link armWatchBatch} always agree about which chains are dead.
 */
const batchHeartbeatDeadline = sql`make_interval(mins => ${watchCadenceMinutes} * 3 + 2)`;

/**
 * Groups that have active watches but no live chain ticking them: the input to the
 * re-arm backstop. A batch chain that dies costs its whole group, so the same sweep
 * that finalizes overdue watches reads this and arms what it finds. A chain ticking
 * normally never appears here.
 */
export async function listWatchBatchGroupsToArm(
  db: DashboardAgentDb,
  params: { now?: Date; limit?: number } = {}
): Promise<WatchBatchGroup[]> {
  const now = params.now ? sql`${params.now.toISOString()}::timestamptz` : sql`now()`;

  return db
    .selectDistinct({
      environmentId: watches.environmentId,
      cadenceMinutes: watchCadenceMinutes,
    })
    .from(watches)
    .leftJoin(
      watchBatches,
      and(
        eq(watchBatches.environmentId, watches.environmentId),
        sql`${watchBatches.cadenceMinutes} = ${watchCadenceMinutes}`
      )
    )
    .where(
      and(
        eq(watches.status, "active"),
        sql`(${watchBatches.environmentId} is null or ${watchBatches.status} = 'stopped' or coalesce(${watchBatches.lastTickAt}, ${watchBatches.armedAt}) <= ${now} - ${batchHeartbeatDeadline})`
      )
    )
    .limit(params.limit ?? 200);
}

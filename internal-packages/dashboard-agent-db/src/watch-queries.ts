import { and, desc, eq, inArray, or, sql, isNull } from "drizzle-orm";
import {
  watchResolutionToWireStatus,
  type WatchExternalNotification,
  type WatchObservedOutcome,
  type WatchResolution,
} from "@internal/dashboard-agent-contracts";
import type { DashboardAgentDb } from "./client.js";
import { generateWatchDeliveryClaimId, generateWatchId } from "./ids.js";
import { lockChatForWatches, type DashboardAgentDbOrTx } from "./internal.js";
import { chats } from "./schema.js";
import {
  watchBatches,
  watches,
  watchSubmissions,
  type PersistedWatchSpec,
  type Watch,
  type WatchBatch,
  type WatchCancelReason,
  type WatchStatus,
  type WatchSubmission,
  type WatchSubmissionState,
} from "./watch-schema.js";

// The watch, wake and batch-chain half of the query layer. Same tenancy rule as
// `queries.ts`: every read is scoped by organization and/or user.

export const MAX_ACTIVE_WATCHES_PER_CHAT = 3;

/** Terminal statuses are immutable. Every transition guards on `active`. */
export function isTerminalWatchStatus(status: string): boolean {
  return status === "fired" || status === "expired" || status === "cancelled";
}

/** Whether a claim is still someone's to hold is {@link claimWatchDelivery}'s call. */
export function isWatchDeliveryOwed(status: string): boolean {
  return status === "pending" || status === "delivering";
}

export type CreateWatchResult =
  | { ok: true; watch: Watch }
  | { ok: false; error: "limit_reached"; activeCount: number }
  | { ok: false; error: "duplicate"; existingId: string | null }
  /** The chat is gone (or was deleted while this create was in flight). */
  | { ok: false; error: "chat_not_found" };

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

/**
 * Dedup is guaranteed by `watches_chat_active_identity_key`, not the pre-check below.
 * The cap holds because the advisory lock makes count-then-insert atomic.
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
      // Makes count-then-insert atomic against a concurrent create and a delete.
      await lockChatForWatches(tx, params.chatId);

      // Re-read under the lock, or a delete that committed while this call was
      // validating gets overtaken by the insert below. Owner-scoped: a chat in another
      // org, or another user's, does not exist for this create.
      const chat = await tx
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
    // Lost the dedup race. Null if the winner went terminal in the meantime.
    const existing = await findActiveWatchByIdentity(db, params);
    return { ok: false, error: "duplicate", existingId: existing?.id ?? null };
  }
}

/**
 * Advisory only and not race-proof. {@link createWatch} re-applies both guardrails
 * atomically and remains the authority.
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

/** Covered by `watches_chat_active_identity_key`. */
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

export async function getWatch(
  db: DashboardAgentDb,
  params: { id: string }
): Promise<Watch | null> {
  const rows = await db.select().from(watches).where(eq(watches.id, params.id)).limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ *
 * The submission ledger
 * ------------------------------------------------------------------ */

export interface WatchSubmissionClaim {
  submission: WatchSubmission;
  /** This call inserted the row, so no earlier attempt exists. */
  claimed: boolean;
}

/**
 * Reserve the ledger row for one submission, or return the row an earlier attempt left.
 * The insert is the mutual exclusion: `(chat_id, client_request_id)` is the primary key,
 * so exactly one attempt is ever the first, and the rest read its outcome.
 */
export async function claimWatchSubmission(
  db: DashboardAgentDb,
  params: {
    chatId: string;
    clientRequestId: string;
    organizationId: string;
    userId: string;
    projectId: string;
    environmentId: string;
    draftHash: string;
    draft: Record<string, unknown>;
    /** Reserved up front, so a converging retry finds the watch by id. */
    watchId: string;
  }
): Promise<WatchSubmissionClaim> {
  const inserted = await db
    .insert(watchSubmissions)
    .values({ ...params, state: "pending" })
    .onConflictDoNothing({
      target: [watchSubmissions.chatId, watchSubmissions.clientRequestId],
    })
    .returning();

  if (inserted[0]) return { submission: inserted[0], claimed: true };

  const existing = await getWatchSubmission(db, params);
  // Only reachable if retention deleted the row between the insert and this read.
  if (!existing) throw new Error("Watch submission vanished between insert and read");
  return { submission: existing, claimed: false };
}

export async function getWatchSubmission(
  db: DashboardAgentDb,
  params: { chatId: string; clientRequestId: string }
): Promise<WatchSubmission | null> {
  const rows = await db
    .select()
    .from(watchSubmissions)
    .where(
      and(
        eq(watchSubmissions.chatId, params.chatId),
        eq(watchSubmissions.clientRequestId, params.clientRequestId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Re-open a refused submission for another attempt, with a fresh reserved watch id: the
 * previous one may already name a cancelled row. A refusal has no side effect to repeat,
 * which is what makes this safe; `created` and `immediate` are never re-opened.
 */
export async function reopenWatchSubmission(
  db: DashboardAgentDb,
  params: { chatId: string; clientRequestId: string; watchId: string }
): Promise<WatchSubmission | null> {
  const rows = await db
    .update(watchSubmissions)
    .set({
      state: "pending",
      watchId: params.watchId,
      unavailable: false,
      externalNotificationStatus: "not_requested",
      externalNotificationReason: null,
      immediateResult: null,
      refusalCode: null,
      refusalError: null,
      refusalExistingId: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(watchSubmissions.chatId, params.chatId),
        eq(watchSubmissions.clientRequestId, params.clientRequestId),
        eq(watchSubmissions.state, "refused")
      )
    )
    .returning();
  return rows[0] ?? null;
}

export interface WatchSubmissionOutcome {
  state: Exclude<WatchSubmissionState, "pending">;
  watchId?: string | null;
  unavailable?: boolean;
  /** What became of the external consent. Replayed verbatim, never re-decided. */
  external?: WatchExternalNotification;
  immediateResult?: string | null;
  refusalCode?: string | null;
  refusalError?: string | null;
  refusalExistingId?: string | null;
}

/**
 * Write the outcome, guarded on `pending`, so the first attempt to finish wins and a
 * concurrent one reads its record instead of overwriting it. `null` means it lost.
 */
export async function recordWatchSubmissionOutcome(
  db: DashboardAgentDb,
  params: { chatId: string; clientRequestId: string } & WatchSubmissionOutcome
): Promise<WatchSubmission | null> {
  const rows = await db
    .update(watchSubmissions)
    .set({
      state: params.state,
      ...(params.watchId !== undefined ? { watchId: params.watchId } : {}),
      unavailable: params.unavailable ?? false,
      externalNotificationStatus: params.external?.status ?? "not_requested",
      externalNotificationReason:
        params.external?.status === "unavailable" ? params.external.reason : null,
      immediateResult: params.immediateResult ?? null,
      refusalCode: params.refusalCode ?? null,
      refusalError: params.refusalError ?? null,
      refusalExistingId: params.refusalExistingId ?? null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(watchSubmissions.chatId, params.chatId),
        eq(watchSubmissions.clientRequestId, params.clientRequestId),
        eq(watchSubmissions.state, "pending")
      )
    )
    .returning();
  return rows[0] ?? null;
}

/** Retention. A submission outlives its watch only as the key that stops a re-create. */
export async function deleteWatchSubmissionsOlderThan(
  db: DashboardAgentDb,
  params: { before: Date; limit?: number }
): Promise<number> {
  const eligible = db
    .select({ ctid: sql`ctid` })
    .from(watchSubmissions)
    .where(sql`${watchSubmissions.createdAt} <= ${params.before.toISOString()}::timestamptz`)
    .limit(params.limit ?? 500);

  const deleted = await db
    .delete(watchSubmissions)
    .where(sql`ctid in ${eligible}`)
    .returning({ chatId: watchSubmissions.chatId });

  return deleted.length;
}

/** Covered by `watches_chat_active_identity_key`, which leads with `chat_id`. */
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

export interface ActiveWatchSummary {
  id: string;
  chatId: string;
  identity: string;
  status: WatchStatus;
  kind: string;
  note: string;
  checkEveryMinutes: number;
  expiresAt: Date;
  /** The last check's reason: tells `terminal_unsatisfied` apart from a timeout. */
  endedReason: string | null;
  /** NULL while active and for every cancellation. */
  resolution: WatchResolution | null;
  observedOutcome: WatchObservedOutcome | null;
}

/**
 * Returns every non-cancelled watch, not only the active ones: the wake banner needs
 * an already-fired watch's kind. Tenancy floor is the join, not the caller's chat ids.
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
 * Shared by the three wake queries so they can't drift. Org and user are asserted on
 * the watch row too, so `watches_org_user_wake_idx` narrows before the join runs.
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

/** A wake is a `fired` or `expired` watch; a cancelled one is never narrated. */
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

/**
 * How many active watches an org has, across all its chats and users. The plan-limit floor
 * is org-wide, so this is org-scoped only; a chat deletion cancels its watches, so `active`
 * is the whole count.
 */
export async function countActiveWatchesForOrg(
  db: DashboardAgentDb,
  params: { organizationId: string }
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(watches)
    .where(and(eq(watches.status, "active"), eq(watches.organizationId, params.organizationId)));
  return rows[0]?.count ?? 0;
}

/**
 * Whether this user has a watch that can still wake them here. Covered by
 * `watches_org_user_active_idx`; a chat deletion cancels its watches, so `active` is enough.
 */
export async function hasActiveWatches(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(watches)
    .where(
      and(
        eq(watches.status, "active"),
        eq(watches.organizationId, params.organizationId),
        eq(watches.userId, params.userId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export interface DashboardAgentWakeActivity {
  unreadWakes: number;
  /** A watch is still running, so a wake can arrive in a tab that has never seen one. */
  hasActiveWatches: boolean;
}

/**
 * The page load's whole wake signal. Both halves are needed: a fresh browser with an active
 * watch and no wake yet must still start polling, or its first wake only lands on a reload.
 */
export async function readDashboardAgentWakeActivity(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string }
): Promise<DashboardAgentWakeActivity> {
  const [unreadWakes, active] = await Promise.all([
    countUnreadWatchWakes(db, params),
    hasActiveWatches(db, params),
  ]);
  return { unreadWakes, hasActiveWatches: active };
}

export interface UnreadWatchWake {
  watchId: string;
  chatId: string;
  outcome: "fired" | "expired";
  /** The watch's note, or its identity when the note is blank. */
  note: string;
  /** `fired_at` for a fire, `last_checked_at` for an expiry. */
  firedAt: Date;
  kind: string;
  identity: string;
  /** Null on a row written before the resolution model. The surface falls back. */
  resolution: WatchResolution | null;
  observedOutcome: WatchObservedOutcome | null;
  /** Landed after the chat's read marker. Only the dot cares. */
  unread: boolean;
}

const UNREAD_WAKE_LIST_LIMIT = 10;

/** Same wake definition and scoping as {@link countUnreadWatchWakes}. */
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

  return rows.map(toUnreadWatchWake);
}

/** The wake row shape both wake readers select. */
type WakeRow = {
  watchId: string;
  chatId: string;
  status: WatchStatus;
  identity: string;
  spec: PersistedWatchSpec;
  resolution: WatchResolution | null;
  observedOutcome: WatchObservedOutcome | null;
  resolvedAt: Date;
  unread: boolean;
};

function toUnreadWatchWake(row: WakeRow): UnreadWatchWake {
  return {
    watchId: row.watchId,
    chatId: row.chatId,
    // Narrowed by the status `in` clause in the wake scope.
    outcome: row.status as "fired" | "expired",
    note: row.spec.note?.trim() || row.identity,
    firedAt: new Date(row.resolvedAt),
    kind: row.spec.kind,
    identity: row.identity,
    resolution: row.resolution,
    observedOutcome: row.observedOutcome,
    unread: row.unread,
  };
}

/**
 * The wake feed the dashboard polls: the recent wakes plus the unread total, in one query. The
 * window count is evaluated before the limit, so it covers unread wakes older than the window.
 */
export async function readWatchWakeFeed(
  db: DashboardAgentDb,
  params: { organizationId: string; userId: string; deliveredAfter: Date }
): Promise<{ unreadWakes: number; wakes: UnreadWatchWake[] }> {
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
      unread: sql<boolean>`${unreadWake}`,
      recent: sql<boolean>`${wakeResolvedAt} > ${params.deliveredAfter.toISOString()}::timestamptz`,
      unreadTotal: sql<number>`(count(*) filter (where ${unreadWake}) over ())::int`,
    })
    .from(watches)
    .innerJoin(chats, eq(chats.id, watches.chatId))
    .where(
      and(
        ...deliveredWakeScope(params),
        or(unreadWake, sql`${wakeResolvedAt} > ${params.deliveredAfter.toISOString()}::timestamptz`)
      )
    )
    .orderBy(desc(wakeResolvedAt))
    .limit(UNREAD_WAKE_LIST_LIMIT);

  return {
    unreadWakes: rows[0]?.unreadTotal ?? 0,
    // Newest first, so the windowed rows are a prefix of the ordered result.
    wakes: rows.filter((row) => row.recent).map(toUnreadWatchWake),
  };
}

/** Same wake definition and scoping as {@link countUnreadWatchWakes}, grouped. */
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

export interface ChatWatchContext {
  organizationId: string;
}

/**
 * Deliberately returns no project or environment: a watch is bound to the requesting
 * turn's environment. The org is the immutable tenancy floor its watches can't leave.
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
 * Only an `active` row transitions, so a check racing the sweeper yields one winner.
 * `status` is derived, never passed, so it can't disagree with the resolution.
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
 * Cancellation is never notified. Guarded on `active`, so a watch that already fired
 * keeps its outcome and its pending notification, and this returns `null`.
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

/** For chat deletion, or the user losing access to the watched project. */
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
 * Both delivery sweeps skip a watch whose chat is deleted, and retention only deletes rows
 * whose delivery is settled — so a wake still owed when the chat goes is kept until the
 * chat's hard delete (30 days) instead of the much shorter watch retention cutoff. Deleting
 * the chat is the answer that the wake is no longer owed.
 *
 * `delivering` is settled too: once the chat is deleted no sweep can re-claim a stale claim,
 * so the row would never leave it. A live deliverer is unharmed — its release is guarded on
 * `delivering` and its delivered mark on the claim, so both no-op and neither is read.
 */
export async function settlePendingWatchDeliveriesForChat(
  db: DashboardAgentDbOrTx,
  params: { chatId: string }
): Promise<Watch[]> {
  return db
    .update(watches)
    .set({ deliveryStatus: "not_required", deliveryClaimedAt: null, deliveryClaimId: null })
    .where(
      and(
        eq(watches.chatId, params.chatId),
        inArray(watches.status, ["fired", "expired"]),
        inArray(watches.deliveryStatus, ["pending", "delivering"])
      )
    )
    .returning();
}

/** The org-deletion path's half of {@link settlePendingWatchDeliveriesForChat}. */
export async function settlePendingWatchDeliveriesForOrganization(
  db: DashboardAgentDbOrTx,
  params: { organizationId: string }
): Promise<number> {
  const rows = await db
    .update(watches)
    .set({ deliveryStatus: "not_required", deliveryClaimedAt: null, deliveryClaimId: null })
    .where(
      and(
        eq(watches.organizationId, params.organizationId),
        inArray(watches.status, ["fired", "expired"]),
        inArray(watches.deliveryStatus, ["pending", "delivering"])
      )
    )
    .returning({ id: watches.id });
  return rows.length;
}

/**
 * How long a `delivering` claim is respected before the wake may be claimed again.
 * Much longer than a delivery takes, so it only releases rows whose deliverer died.
 */
export const WATCH_DELIVERY_CLAIM_STALE_MS = 5 * 60 * 1000;

export interface WatchDeliveryClaim {
  watch: Watch;
  /**
   * The fencing token. {@link releaseWatchDelivery} and {@link markWatchDelivered}
   * only act while the row still carries it.
   */
  claimId: string;
}

/**
 * The gate that keeps "exactly one wake" true: only the row this returns may append.
 * Every claim writes a fresh `deliveryClaimId`, which is what makes takeover safe.
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
 * Fenced on `claimId`, so a late release can't hand somebody else's in-flight claim
 * back to `pending`. Guarded on `delivering`, so it can't un-deliver a landed wake.
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
 * With a `claimId` the mark is fenced on it. Without one it marks a `pending` row,
 * never a `delivering` one: an unfenced mark must not finish a claim it doesn't own.
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
 * The only writer of `tickCount`, and resumable on purpose: it lands on the previous
 * or current generation, never a later one, so a crashed tick can re-run.
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
 * Deliberately does not touch `tickCount`, keeping {@link claimWatchTick} its single
 * writer. Guarded on `active`, so a concurrent fire or expire wins and this no-ops.
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
      // A check is also a look, so the fairness key moves with it.
      lastAttemptedAt: params.lastCheckedAt ?? sql`now()`,
      ...(params.lastResult !== undefined ? { lastResult: params.lastResult } : {}),
    })
    .where(and(eq(watches.id, params.id), eq(watches.status, "active")))
    .returning({ tickCount: watches.tickCount, lastCheckedAt: watches.lastCheckedAt });
  return rows[0] ?? null;
}

/**
 * A look that read nothing. Moves the batch's fairness key only, so a permanently broken
 * reader rotates out of its group's head while its dueness and streak facts stay untouched.
 * Guarded on `active`, like {@link recordWatchCheck}.
 */
export async function recordWatchAttempt(
  db: DashboardAgentDb,
  params: { id: string; lastAttemptedAt?: Date }
): Promise<void> {
  await db
    .update(watches)
    .set({ lastAttemptedAt: params.lastAttemptedAt ?? sql`now()` })
    .where(and(eq(watches.id, params.id), eq(watches.status, "active")));
}

/**
 * Sweep for terminal watches `listExpiredActiveWatches` cannot see. `olderThan` is a
 * grace window, so recovery can't race a path that is still mid-delivery.
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

/** The marker one terminal outcome's alert is dispatched under. */
export function watchAlertDispatchKey(params: { id: string; terminalStatus: string }): string {
  return `watch:${params.id}:alert:${params.terminalStatus}`;
}

/**
 * Claim the right to alert for this watch's terminal outcome, exactly once. The marker is
 * on the row, so a repeated callback — a retried task, a replayed token — sends nothing.
 * `false` means the alert was already dispatched; the caller answers success anyway.
 */
export async function claimWatchAlertDispatch(
  db: DashboardAgentDb,
  params: { id: string; terminalStatus: WatchStatus }
): Promise<boolean> {
  const key = watchAlertDispatchKey({ id: params.id, terminalStatus: params.terminalStatus });
  const rows = await db
    .update(watches)
    .set({ alertDispatchKey: key })
    .where(
      and(
        eq(watches.id, params.id),
        // The row must still be in the outcome the caller is alerting for.
        eq(watches.status, params.terminalStatus),
        isNull(watches.alertDispatchKey)
      )
    )
    .returning({ id: watches.id });
  return rows.length > 0;
}

/**
 * Hand the claim back when the dispatch it was taken for could not be queued, so the
 * caller's retry can alert. Fenced on the key, so it can't clear a later claim.
 */
export async function releaseWatchAlertDispatch(
  db: DashboardAgentDb,
  params: { id: string; terminalStatus: WatchStatus }
): Promise<void> {
  const key = watchAlertDispatchKey({ id: params.id, terminalStatus: params.terminalStatus });
  await db
    .update(watches)
    .set({ alertDispatchKey: null })
    .where(and(eq(watches.id, params.id), eq(watches.alertDispatchKey, key)));
}

/**
 * Retention sweep. Guarded on settled delivery, so a row that still owes a wake is
 * never deleted from under the delivery sweep. Only `watches` rows, never history.
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
        // The materialized clock, so this is an index range scan on
        // `watches_retention_idx` rather than a seq scan over an expression.
        sql`${watches.retentionAt} <= ${params.before.toISOString()}::timestamptz`
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
 * Callers run the final boundary evaluation and resolve these via
 * `transitionWatchCondition`, which may still be `condition_met`.
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

// Generated from `spec`, so it can't disagree with it, and indexed by
// `watches_active_env_cadence_idx`.
const watchCadenceMinutes = watches.cadenceMinutes;

/** A group larger than this is checked across several ticks, oldest check first. */
const BATCH_GROUP_LIMIT = 500;

/**
 * How long ago this watch was last looked at, a look that read nothing included. A
 * never-looked-at watch sorts by creation. Dueness reads `lastCheckedAt` instead.
 */
const watchLastLookedAt = sql`coalesce(${watches.lastAttemptedAt}, ${watches.lastCheckedAt}, ${watches.createdAt})`;

/**
 * Which of these are due is the caller's decision, from the tick's own clock.
 *
 * Least-recently-looked-at first is the fairness invariant: a group over the cap rotates, so
 * every watch is reached within `ceil(group / cap)` ticks instead of the same prefix winning
 * every tick. Watches whose window closes within a cadence still sort first, so a group over
 * the cap never defers a final evaluation.
 */
export async function listActiveWatchesForBatch(
  db: DashboardAgentDb,
  params: { environmentId: string; cadenceMinutes: number; limit?: number }
): Promise<Watch[]> {
  const closingSoon = sql`(${watches.expiresAt} <= now() + make_interval(mins => ${params.cadenceMinutes})) desc`;

  return db
    .select()
    .from(watches)
    .where(
      and(
        eq(watches.status, "active"),
        eq(watches.environmentId, params.environmentId),
        eq(watchCadenceMinutes, params.cadenceMinutes)
      )
    )
    .orderBy(closingSoon, watchLastLookedAt, watches.expiresAt)
    .limit(params.limit ?? BATCH_GROUP_LIMIT);
}

/**
 * The batch's half of the delivery backstop: a retried run can't see a watch that left
 * the `active` set mid-run. No grace window; the fenced claim settles racing deliverers.
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
        eq(watchCadenceMinutes, params.cadenceMinutes),
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
 * A returned row means this call armed the chain, so the caller must trigger the run
 * owning `epoch` / `generation + 1`. `null` means a live chain already covers the group.
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
 * The batch twin of {@link claimWatchTick}, plus an epoch fence so a zombie chain from
 * before a re-arm exits. Also the heartbeat the re-arm backstop reads.
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
 * Fenced on the epoch, so a stop decided by one epoch's run can't end the chain a
 * later arm started.
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

export interface WatchBatchGroup {
  environmentId: string;
  cadenceMinutes: number;
}

/**
 * Must stay in step with `watchBatchStaleMs`, which applies the same formula in
 * TypeScript, or this listing and {@link armWatchBatch} disagree about dead chains.
 */
const batchHeartbeatDeadline = sql`make_interval(mins => ${watchCadenceMinutes} * 3 + 2)`;

/** Input to the re-arm backstop. A chain ticking normally never appears here. */
export async function listWatchBatchGroupsToArm(
  db: DashboardAgentDb,
  params: { now?: Date; limit?: number } = {}
): Promise<WatchBatchGroup[]> {
  const now = params.now ? sql`${params.now.toISOString()}::timestamptz` : sql`now()`;

  return db
    .selectDistinct({
      environmentId: watches.environmentId,
      cadenceMinutes: sql<number>`${watchCadenceMinutes}`,
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

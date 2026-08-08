import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  WatchExternalNotificationStatus,
  WatchObservedOutcome,
  WatchResolution,
  WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { dashboardAgentSchema } from "./schema-base.js";

// The watch tables. Re-exported by `schema.ts`, which is what drizzle-kit reads.

/** `active` is the only non-terminal status; the other three are immutable. */
export type WatchStatus = "active" | "fired" | "expired" | "cancelled";
/**
 * `not_required` while active and for every cancellation. `delivering` is the
 * in-flight claim, one deliverer at a time. See `claimWatchDelivery`.
 */
export type WatchDeliveryStatus = "not_required" | "pending" | "delivering" | "delivered";
/** Cancellations are silent: no resolution, no wake. */
export type WatchCancelReason =
  | "user"
  | "access_revoked"
  | "chat_deleted"
  | "scheduling_failed"
  /** A concurrent attempt at the same submission recorded a different outcome first. */
  | "superseded";

/** `since` is server-set at creation, so `error_recurrence` can't match older errors. */
export type PersistedWatchSpec = WatchSpec & { since?: string };

/**
 * The initiating identity is snapshotted at creation, so a membership change can only
 * cancel a watch, never widen its scope. Main-DB ids, FK-free.
 */
export const watches = dashboardAgentSchema.table(
  "watches",
  {
    id: text("id").primaryKey(), // = watchId (`watch_…`)
    chatId: text("chat_id").notNull(), // = chats.id
    identity: text("identity").notNull(),
    spec: jsonb("spec").$type<PersistedWatchSpec>().notNull(),
    status: text("status").$type<WatchStatus>().notNull().default("active"),
    deliveryStatus: text("delivery_status")
      .$type<WatchDeliveryStatus>()
      .notNull()
      .default("not_required"),
    cancelReason: text("cancel_reason").$type<WatchCancelReason>(),
    /**
     * The meaning; `status` above stays the two-value transport encoding so persisted
     * wake ids and dedup keys remain valid. NULL while active and on cancellation.
     */
    resolution: text("resolution").$type<WatchResolution>(),
    /** Written in the same statement as `resolution` and `lastResult`. */
    observedOutcome: jsonb("observed_outcome").$type<WatchObservedOutcome>(),
    /** Consent given at creation. Never part of `identity`. */
    investigateOnAttention: boolean("investigate_on_attention").notNull().default(false),
    // Immutable initiating identity, snapshotted at creation.
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    /** Nullable: rows created before this column don't carry it. */
    projectRef: text("project_ref"),
    environmentId: text("environment_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    /**
     * Every look, a check that could read nothing included. Dueness reads `lastCheckedAt`;
     * this is only the batch's fairness key, so a broken reader can't hold the group's head.
     */
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    // A claim older than the delivery grace is abandoned and may be re-claimed.
    deliveryClaimedAt: timestamp("delivery_claimed_at", { withTimezone: true }),
    // Fencing token, written fresh on every claim and required by the release and
    // delivered marks, so a revived deliverer can't touch the claim that replaced it.
    deliveryClaimId: text("delivery_claim_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // On fire or expire this is the notification's payload.
    lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
    // Check idempotency keys are `watch:{id}:tick:{n}`.
    tickCount: integer("tick_count").notNull().default(0),
    /**
     * The durable "this outcome has already been alerted" marker, `watch:{id}:alert:{status}`.
     * Written once by {@link claimWatchAlertDispatch}, so a repeated callback sends nothing.
     */
    alertDispatchKey: text("alert_dispatch_key"),
    /**
     * The retention clock, materialized so the sweep is an index range scan instead of a
     * seq scan over a `greatest(...)` expression. Generated, so no writer can let it drift.
     */
    retentionAt: timestamp("retention_at", { withTimezone: true }).generatedAlwaysAs(
      sql`greatest(delivered_at, cancelled_at, fired_at, last_checked_at, created_at)`
    ),
    /**
     * The batch group's second key. Generated from `spec`, so no write path can let it
     * drift, and the batch predicate is served by an index instead of re-parsing JSON.
     */
    cadenceMinutes: integer("cadence_minutes").generatedAlwaysAs(
      sql`((spec ->> 'checkEveryMinutes')::int)`
    ),
  },
  (t) => [
    index("watches_chat_idx").on(t.chatId),
    // UNIQUE is the dedup guarantee: a read-then-insert check can't be race-proof
    // under READ COMMITTED. Leading `chat_id` also serves the active-watches lookup.
    uniqueIndex("watches_chat_active_identity_key")
      .on(t.chatId, t.projectId, t.environmentId, t.identity)
      .where(sql`${t.status} = 'active'`),
    // Sweep: active watches due to be checked / past their expiry.
    index("watches_status_expires_idx").on(t.status, t.expiresAt),
    // Sweep: resolved watches whose wake is still owed.
    index("watches_pending_delivery_idx")
      .on(t.firedAt, t.lastCheckedAt)
      .where(sql`${t.deliveryStatus} in ('pending', 'delivering')`),
    // Tenant columns must lead so the index, not the `chats` join, narrows to this
    // user first. The trailing expression is what the wake queries filter and order on.
    index("watches_org_user_wake_idx")
      .on(t.organizationId, t.userId, sql`coalesce(${t.firedAt}, ${t.lastCheckedAt}) desc`)
      .where(sql`${t.deliveryStatus} = 'delivered' and ${t.status} in ('fired', 'expired')`),
    // Covers the page load's "does this user have a live watch" read.
    index("watches_org_user_active_idx")
      .on(t.organizationId, t.userId)
      .where(sql`${t.status} = 'active'`),
    // Covers the batch group lookups. The trailing key is what the batch orders by, so
    // the group's least-recently-checked watches are the ones the cap keeps.
    index("watches_active_env_cadence_idx")
      .on(
        t.environmentId,
        t.cadenceMinutes,
        sql`coalesce(${t.lastAttemptedAt}, ${t.lastCheckedAt}, ${t.createdAt})`,
        t.expiresAt
      )
      .where(sql`${t.status} = 'active'`),
    // The batch delivery backstop. `watches_active_env_cadence_idx` is partial on
    // `status = 'active'`, so it cannot serve a resolved-but-undelivered lookup at all.
    index("watches_env_cadence_delivery_idx")
      .on(
        t.environmentId,
        t.cadenceMinutes,
        t.deliveryStatus,
        sql`coalesce(${t.firedAt}, ${t.lastCheckedAt})`
      )
      .where(
        sql`${t.status} in ('fired', 'expired') and ${t.deliveryStatus} in ('pending', 'delivering')`
      ),
    // Retention. Plain B-tree on the materialized clock, partial on the settled set the
    // sweep is allowed to delete.
    index("watches_retention_idx")
      .on(t.retentionAt)
      .where(
        sql`${t.status} in ('fired', 'expired', 'cancelled') and ${t.deliveryStatus} in ('not_required', 'delivered')`
      ),
  ]
);

export type WatchBatchStatus = "running" | "stopped";

/**
 * `epoch` and `generation` are claimed together by {@link claimWatchBatchTick}, so a
 * duplicated schedule can't fork the chain. FK-free.
 */
export const watchBatches = dashboardAgentSchema.table(
  "watch_batches",
  {
    environmentId: text("environment_id").notNull(),
    // 1 | 5 | 15 | 60.
    cadenceMinutes: integer("cadence_minutes").notNull(),
    // Bumped by every arm. Runs carry it, and a claim requires it to match.
    epoch: integer("epoch").notNull().default(0),
    // Inside the current epoch. The claim is its only writer.
    generation: integer("generation").notNull().default(0),
    status: text("status").$type<WatchBatchStatus>().notNull().default("running"),
    armedAt: timestamp("armed_at", { withTimezone: true }).notNull().defaultNow(),
    // Heartbeat. NULL between an arm and the first run landing.
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.environmentId, t.cadenceMinutes] })]
);

/**
 * `pending` is the only re-enterable state: the attempt that owns it died before it wrote
 * an outcome. `created` and `immediate` are terminal — replayed, never re-evaluated.
 * `refused` records an attempt that produced no side effect, so it may be re-attempted.
 */
export type WatchSubmissionState = "pending" | "created" | "immediate" | "refused";

/**
 * The authoritative record of one card submission, keyed by `(chat_id, client_request_id)`.
 * Written before the watch, so a retry replays this row's outcome instead of re-evaluating
 * the condition and creating a second operation. Main-DB ids, FK-free.
 */
export const watchSubmissions = dashboardAgentSchema.table(
  "watch_submissions",
  {
    chatId: text("chat_id").notNull(), // = chats.id
    /** Stable per card submission, held across the client's retries. */
    clientRequestId: text("client_request_id").notNull(),
    // Immutable tenancy snapshot, same rule as `watches`.
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    /** sha256 of the normalized draft. A different draft under this key is a conflict. */
    draftHash: text("draft_hash").notNull(),
    /** The draft itself, so a replay rebuilds both records from the row alone. */
    draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
    state: text("state").$type<WatchSubmissionState>().notNull().default("pending"),
    /**
     * Reserved before the insert into `watches`, so an attempt that died mid-create is
     * recognised by id rather than by looking for an active duplicate.
     */
    watchId: text("watch_id"),
    /** `created` only: the creation-time check couldn't run. */
    unavailable: boolean("unavailable").notNull().default(false),
    /**
     * `created` only: what became of the external ("email me as well") consent. The reason
     * is kept so a replay reproduces the same confirmation instead of guessing again.
     */
    externalNotificationStatus: text("external_notification_status")
      .$type<WatchExternalNotificationStatus>()
      .notNull()
      .default("not_requested"),
    externalNotificationReason: text("external_notification_reason"),
    /** `immediate` only: `satisfied` or `terminal_unsatisfied`. */
    immediateResult: text("immediate_result"),
    // `refused` only. Kept verbatim so the replayed refusal reads identically.
    refusalCode: text("refusal_code"),
    refusalError: text("refusal_error"),
    refusalExistingId: text("refusal_existing_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The uniqueness that makes the ledger authoritative: one row per submission.
    primaryKey({ columns: [t.chatId, t.clientRequestId] }),
    // Retention scans by age across every tenant.
    index("watch_submissions_created_idx").on(t.createdAt),
  ]
);

export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
export type WatchBatch = typeof watchBatches.$inferSelect;
export type WatchSubmission = typeof watchSubmissions.$inferSelect;

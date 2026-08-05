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
export type WatchCancelReason = "user" | "access_revoked" | "chat_deleted" | "scheduling_failed";

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
    // Covers `listActiveWatchesForBatch`.
    index("watches_active_env_idx")
      .on(t.environmentId, t.expiresAt)
      .where(sql`${t.status} = 'active'`),
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

export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
export type WatchBatch = typeof watchBatches.$inferSelect;

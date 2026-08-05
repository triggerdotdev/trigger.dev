import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  WatchObservedOutcome,
  WatchResolution,
  WatchSpec,
} from "@internal/dashboard-agent-contracts";

// Tables are schema-qualified explicitly, so the connection needs no `search_path`.
export const dashboardAgentSchema = pgSchema("trigger_dashboard_agent");

/**
 * Scoped to org + user. `organizationId` and `userId` are main-DB ids with no FK:
 * in cloud this table lives in a different database.
 */
export const chats = dashboardAgentSchema.table(
  "chats",
  {
    // = the Session externalId.
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default("New chat"),
    // Display copy. Never read to rebuild model context.
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    // NULL means never read, so everything in the chat counts as unread.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Covers `listChats`. Partial, so soft-deleted rows stay out of the hot path.
    index("chats_org_user_last_msg_idx")
      .on(t.organizationId, t.userId, t.lastMessageAt.desc())
      .where(sql`${t.deletedAt} is null`),
  ]
);

/**
 * No `userId` on purpose: `onTurnComplete` doesn't carry `clientData`, so
 * `getSession` joins `chats` to scope by owner instead.
 */
export const chatSessions = dashboardAgentSchema.table("chat_sessions", {
  chatId: text("chat_id").primaryKey(), // = chats.id (FK-free, cross-db)
  publicAccessToken: text("public_access_token").notNull(),
  lastEventId: text("last_event_id"),
  runId: text("run_id"), // telemetry / "view this run"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only, written by `dashboard-agent-eval-turn`. Org + user scoped, FK-free;
 * the composite `(chatId, turn)` key stops a re-delivered turn double-inserting.
 */
export const chatTurnEvals = dashboardAgentSchema.table(
  "chat_turn_evals",
  {
    chatId: text("chat_id").notNull(), // = chats.id
    turn: integer("turn").notNull(), // 0-indexed turn within the chat
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    agentRunId: text("agent_run_id"), // the chat.agent run that produced the turn
    evalRunId: text("eval_run_id"), // the eval task's own run, for tracing
    projectRef: text("project_ref"),
    environment: text("environment"),
    currentPage: text("current_page"),
    model: text("model"),
    promptSlug: text("prompt_slug"),
    promptVersion: integer("prompt_version"),
    toolsUsed: jsonb("tools_used").$type<string[]>().notNull().default([]),
    toolError: boolean("tool_error").notNull().default(false),
    // Judge scores, 1-5.
    judgeModel: text("judge_model"),
    scoreGrounded: smallint("score_grounded"),
    scoreAnswered: smallint("score_answered"),
    scoreConcise: smallint("score_concise"),
    passed: boolean("passed"),
    // Filterable summary of `signals`.
    intentCategory: text("intent_category"),
    outcome: text("outcome"), // resolved | partial | unresolved | deflected
    sentiment: text("sentiment"),
    capabilityGap: boolean("capability_gap").notNull().default(false),
    docsGap: boolean("docs_gap").notNull().default(false),
    supportOpportunity: boolean("support_opportunity").notNull().default(false),
    featureRequest: boolean("feature_request").notNull().default(false),
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    signals: jsonb("signals").$type<unknown[]>().notNull().default([]),
    summary: text("summary"),
    userText: text("user_text"), // the user's question (clustering input)
    judge: jsonb("judge").$type<Record<string, unknown>>(), // full raw verdict
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.turn] }),
    index("chat_turn_evals_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    index("chat_turn_evals_org_opps_idx")
      .on(t.organizationId, t.createdAt.desc())
      .where(
        sql`${t.capabilityGap} or ${t.docsGap} or ${t.supportOpportunity} or ${t.featureRequest}`
      ),
  ]
);

/**
 * The (chatId, projectRef, environmentRef) triple is the tenancy check on every
 * write. Both refs are main-DB ids with no FK.
 */
export const investigations = dashboardAgentSchema.table(
  "investigations",
  {
    id: text("id").primaryKey(), // = investigationId (`inv_…`)
    chatId: text("chat_id").notNull(), // = chats.id
    projectRef: text("project_ref").notNull(),
    environmentRef: text("environment_ref").notNull(),
    // Monotonic; bumped by a single atomic UPDATE.
    revision: integer("revision").notNull().default(0),
    state: jsonb("state").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("investigations_chat_idx").on(t.chatId)]
);

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

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatTurnEval = typeof chatTurnEvals.$inferSelect;
export type NewChatTurnEval = typeof chatTurnEvals.$inferInsert;
export type Investigation = typeof investigations.$inferSelect;
export type NewInvestigation = typeof investigations.$inferInsert;
export type Watch = typeof watches.$inferSelect;
export type NewWatch = typeof watches.$inferInsert;
export type WatchBatch = typeof watchBatches.$inferSelect;

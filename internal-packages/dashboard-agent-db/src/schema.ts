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

/**
 * All dashboard-agent tables live in a dedicated Postgres schema: a separate
 * database in cloud, isolation from Prisma's `public` schema in OSS. Tables are
 * schema-qualified explicitly, so the connection needs no `search_path` setup.
 */
export const dashboardAgentSchema = pgSchema("trigger_dashboard_agent");

/**
 * One row per conversation, scoped to org + user. A chat is not bound to one
 * project or environment, because a conversation can range over several; those
 * live in `metadata`.
 *
 * `messages` is a display copy of the transcript. The model's source of truth is
 * chat.agent's object-store snapshot, so a stale write here can make the History
 * view lag a turn but can never corrupt what the model sees.
 *
 * Foreign-key-free: `organizationId` and `userId` are main-DB ids with no FK,
 * because in cloud this table lives in a different database.
 */
export const chats = dashboardAgentSchema.table(
  "chats",
  {
    // = the Session externalId. Stable for the life of the thread.
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default("New chat"),
    // UIMessage[] display copy. Never read to rebuild model context.
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    // Project/env context, model choice, page snapshot.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    // When the user last had this chat in front of them. NULL means never read, so
    // everything in it counts as unread.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "My chats in this org, recent first". Partial, so soft-deleted rows stay out
    // of the hot path.
    index("chats_org_user_last_msg_idx")
      .on(t.organizationId, t.userId, t.lastMessageAt.desc())
      .where(sql`${t.deletedAt} is null`),
  ]
);

/**
 * Live transport state needed to resume a chat, keyed by chatId. Separate from
 * `chats` so the secret token is isolated from list queries and the hot per-turn
 * write stays off the conversation row.
 *
 * No `userId` on purpose: the agent's `onTurnComplete` event doesn't carry
 * `clientData`, and `getSession` joins `chats` to scope by owner instead.
 */
export const chatSessions = dashboardAgentSchema.table("chat_sessions", {
  chatId: text("chat_id").primaryKey(), // = chats.id (FK-free, cross-db)
  publicAccessToken: text("public_access_token").notNull(),
  lastEventId: text("last_event_id"),
  runId: text("run_id"), // telemetry / "view this run"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per evaluated turn, written by the `dashboard-agent-eval-turn` task.
 * Append-only analytics: quality scores and insight classification. Higher-level
 * views are aggregations over these rows, not stored here.
 *
 * Structured columns are what we filter, alert and chart on; the evolving taxonomy
 * (`signals`) and the raw judge output live in JSONB, so adding a signal type is
 * never a migration. Org + user scoped, FK-free, with a composite `(chatId, turn)`
 * key so a re-delivered turn can't double-insert.
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
    // Per-turn context (the project/env/page the user was looking at).
    projectRef: text("project_ref"),
    environment: text("environment"),
    currentPage: text("current_page"),
    // `promptVersion` lets a quality drop be attributed to a dashboard-managed
    // prompt edit that never went through CI.
    model: text("model"),
    promptSlug: text("prompt_slug"),
    promptVersion: integer("prompt_version"),
    toolsUsed: jsonb("tools_used").$type<string[]>().notNull().default([]),
    toolError: boolean("tool_error").notNull().default(false),
    // Quality (LLM judge), scored 1-5.
    judgeModel: text("judge_model"),
    scoreGrounded: smallint("score_grounded"),
    scoreAnswered: smallint("score_answered"),
    scoreConcise: smallint("score_concise"),
    passed: boolean("passed"),
    // Insight classification: the filterable summary of `signals`.
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
    // The opportunities feed: gaps, struggles, support, feature asks.
    index("chat_turn_evals_org_opps_idx")
      .on(t.organizationId, t.createdAt.desc())
      .where(
        sql`${t.capabilityGap} or ${t.docsGap} or ${t.supportOpportunity} or ${t.featureRequest}`
      ),
  ]
);

/**
 * One row per investigation: the agent's revisioned working state for a diagnostic
 * thread. The primary key is the `investigationId`, so a follow-up turn can load an
 * investigation from the id alone without knowing which chat it belongs to.
 *
 * `state` is untyped JSONB because the payload shape is still moving, and pinning a
 * `$type` would make every shape change a migration. The projectRef/environmentRef
 * pair is the tenancy check for every write: a revision bump must come from the same
 * chat, project and environment that created the investigation.
 *
 * `projectRef` is the project's external ref (`proj_…`), the same identifier the
 * `trigger://` URI scheme uses. `environmentRef` is `RuntimeEnvironment.id`. Both
 * are main-DB ids with no FK.
 */
export const investigations = dashboardAgentSchema.table(
  "investigations",
  {
    id: text("id").primaryKey(), // = investigationId (`inv_…`)
    chatId: text("chat_id").notNull(), // = chats.id
    projectRef: text("project_ref").notNull(),
    environmentRef: text("environment_ref").notNull(),
    // Monotonic per investigation; bumped by a single atomic UPDATE.
    revision: integer("revision").notNull().default(0),
    state: jsonb("state").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("investigations_chat_idx").on(t.chatId),
  ]
);

/** `active` is the only non-terminal status; the other three are immutable. */
export type WatchStatus = "active" | "fired" | "expired" | "cancelled";
/**
 * `not_required` while active and for every cancellation; only fired and expired
 * notify. `delivering` is the in-flight claim, one deliverer at a time, so two
 * concurrent invocations can't both wake the chat. See `claimWatchDelivery`.
 */
export type WatchDeliveryStatus = "not_required" | "pending" | "delivering" | "delivered";
/**
 * `scheduling_failed` is the one cancellation the system issues on its own: the
 * first tick could not be scheduled, so nothing would ever check this watch.
 * Silent like every other cancellation — no resolution, no wake.
 */
export type WatchCancelReason = "user" | "access_revoked" | "chat_deleted" | "scheduling_failed";

/**
 * The persisted spec adds a server-set `since` to the caller's spec: the watch's
 * creation time, used by `error_recurrence` so a recurrence check can't match errors
 * that predate the watch. Inside the JSONB because it is part of the check's input,
 * not watch lifecycle state.
 */
export type PersistedWatchSpec = WatchSpec & { since?: string };

/**
 * One row per watch: "tell me when X happens", checked by a periodic task.
 *
 * The initiating identity (`organizationId`, `projectId`, `environmentId`, `userId`)
 * is a snapshot taken at creation and never updated, so a watch fires with exactly
 * the access its creator had and a later membership change can only cancel it
 * (`cancel_reason = 'access_revoked'`), never widen its scope. Main-DB ids, FK-free.
 *
 * `identity` is the caller-computed dedup key for the watched thing. Its own column,
 * so the "already watching this" lookup is an indexed query, not a JSONB dig.
 *
 * Status and delivery transitions are guarded in the query layer with
 * `WHERE status = 'active' … RETURNING` rather than by DB constraints, so a
 * concurrent fire, expire or cancel resolves to exactly one winner.
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
     * How the watch ended: `condition_met`, `window_completed` or
     * `condition_impossible`. `status` above stays the two-value transport encoding,
     * so persisted wake ids and dedup keys remain valid; this column is the meaning.
     * NULL while active and on every cancellation.
     */
    resolution: text("resolution").$type<WatchResolution>(),
    /**
     * What the resolving check observed. Written in the same statement as
     * `resolution` and `lastResult`, so delivery never re-reads the source to
     * reconstruct what happened and a retry cannot rebuild a different headline.
     */
    observedOutcome: jsonb("observed_outcome").$type<WatchObservedOutcome>(),
    /**
     * Consent, given at creation, for the wake turn to open an investigation after
     * an attention outcome without asking. Not part of the spec and never part of
     * `identity`, because two watches on the same thing are the same watch whatever
     * they do afterwards.
     */
    investigateOnAttention: boolean("investigate_on_attention").notNull().default(false),
    // Immutable initiating identity, snapshotted at creation.
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    /**
     * The project's external ref (`proj_…`), the same identifier the `trigger://`
     * scheme and the investigations table use. Carried on the row because a wake has
     * to scope an investigation exactly as a turn would, and the agent has no access
     * to the main database to translate an internal project id. Nullable, because
     * rows created before this column don't carry it.
     */
    projectRef: text("project_ref"),
    environmentId: text("environment_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    // When the current deliverer claimed the wake. A claim older than the
    // delivery grace is treated as abandoned and may be re-claimed.
    deliveryClaimedAt: timestamp("delivery_claimed_at", { withTimezone: true }),
    // Which deliverer holds the claim: the fencing token. Written fresh on every
    // claim, including a stale takeover, and required by the release and delivered
    // marks, so a deliverer that comes back from the dead can't release or complete
    // the claim that replaced its own.
    deliveryClaimId: text("delivery_claim_id"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // The last check's output. On fire or expire it is the notification's payload.
    lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
    // Ticks so far. Check idempotency keys are `watch:{id}:tick:{n}`.
    tickCount: integer("tick_count").notNull().default(0),
  },
  (t) => [
    index("watches_chat_idx").on(t.chatId),
    // UNIQUE is the dedup guarantee: a read-then-insert check can't be race-proof
    // under READ COMMITTED, so the constraint has to live in the DB. Partial on
    // `active`, because re-watching the same thing after a watch fired must be
    // allowed. Leading `chat_id` means this also serves the "active watches of this
    // chat" lookup, so no separate non-unique partial index is needed.
    uniqueIndex("watches_chat_active_identity_key")
      .on(t.chatId, t.projectId, t.environmentId, t.identity)
      .where(sql`${t.status} = 'active'`),
    // Sweep: active watches due to be checked / past their expiry.
    index("watches_status_expires_idx").on(t.status, t.expiresAt),
    // The other half of the sweep: resolved watches whose wake is still owed, never
    // claimed or claimed by a deliverer that died mid-flight. Partial, because "owed"
    // is a handful of rows at any moment.
    index("watches_pending_delivery_idx")
      .on(t.firedAt, t.lastCheckedAt)
      .where(sql`${t.deliveryStatus} in ('pending', 'delivering')`),
    // The panel's wake feed, run twice per poll of a closed panel (the dot's count
    // and the toast's list). Tenant columns lead so the index, not the `chats` join,
    // narrows to this user first; the trailing expression is the resolution time both
    // queries filter and order on. Partial on the delivered-wake predicate.
    index("watches_org_user_wake_idx")
      .on(t.organizationId, t.userId, sql`coalesce(${t.firedAt}, ${t.lastCheckedAt}) desc`)
      .where(sql`${t.deliveryStatus} = 'delivered' and ${t.status} in ('fired', 'expired')`),
    // One batch tick loads every active watch of one environment in a single read.
    // See `listActiveWatchesForBatch`. Partial on `active`, so the terminal rows an
    // environment accumulates never enter it.
    index("watches_active_env_idx")
      .on(t.environmentId, t.expiresAt)
      .where(sql`${t.status} = 'active'`),
  ]
);

/** A batch chain is either ticking or it has stopped; nothing in between. */
export type WatchBatchStatus = "running" | "stopped";

/**
 * One row per (environment, cadence) batch chain: the registry that makes one tick
 * run per environment per cadence possible instead of one run per watch. A new watch
 * joins a live chain rather than starting a second one, so N watches in an
 * environment cost one tick run, one authorization and one report read per cadence.
 *
 * The row is the single point two concurrent writers agree at. `epoch` and
 * `generation` are claimed together by {@link claimWatchBatchTick}, so a duplicated
 * schedule can't fork the chain, and `lastTickAt` is the heartbeat the webapp's
 * re-arm backstop reads.
 *
 * `epoch` is what makes re-arming safe: a run from a previous epoch claims nothing and
 * exits, so a zombie chain can never tick alongside its replacement, and the successor
 * idempotency keys of the two epochs can never collide.
 *
 * FK-free like every other table here: `environmentId` is a main-DB id.
 */
export const watchBatches = dashboardAgentSchema.table(
  "watch_batches",
  {
    environmentId: text("environment_id").notNull(),
    // 1 | 5 | 15 | 60 — the cadences a watch spec may ask for.
    cadenceMinutes: integer("cadence_minutes").notNull(),
    // Bumped by every arm. Runs carry it, and a claim requires it to match.
    epoch: integer("epoch").notNull().default(0),
    // The tick generation inside the current epoch. The claim is its only writer.
    generation: integer("generation").notNull().default(0),
    status: text("status").$type<WatchBatchStatus>().notNull().default("running"),
    armedAt: timestamp("armed_at", { withTimezone: true }).notNull().defaultNow(),
    // The heartbeat: when a run last claimed a generation. NULL between an arm and
    // the first run landing.
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

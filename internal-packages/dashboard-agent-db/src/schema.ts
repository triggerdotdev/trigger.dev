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
import type { WatchSpec } from "@internal/dashboard-agent-contracts";

/**
 * All dashboard-agent tables live in a dedicated Postgres schema. In cloud this
 * is a separate PlanetScale database; in OSS it isolates the agent's tables from
 * Prisma's `public` schema inside the main database. Tables are schema-qualified
 * explicitly, so no `search_path` configuration is required on the connection.
 */
export const dashboardAgentSchema = pgSchema("trigger_dashboard_agent");

/**
 * One row per conversation. Scope is **org + user** — a chat is not bound to a
 * single project/env; the project/env it ran in (and any extra ones the user
 * adds to context) live in `metadata`, because one conversation can range over
 * several projects/envs.
 *
 * `messages` is a display copy of the `UIMessage[]` transcript. The model's
 * source of truth for history is chat.agent's built-in object-store snapshot,
 * not this column — a stale write here can make the History view lag a turn but
 * can never corrupt what the model sees.
 *
 * Foreign-key-free: `organizationId` / `userId` are main-DB ids with no FK,
 * because in cloud this table lives in a different database.
 */
export const chats = dashboardAgentSchema.table(
  "chats",
  {
    // = chatId = the Session externalId. Stable for the life of the thread.
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default("New chat"),
    // UIMessage[] display copy — never read to rebuild model context.
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    // Project/env context + model choice + page snapshot. Flexible by design.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    // When the user last had this chat in front of them. NULL means never read,
    // so everything in it counts as unread — the launcher's dot compares watch
    // wakes against this.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // History tab: "my chats in this org, recent first". Partial index keeps
    // soft-deleted rows out of the hot path.
    index("chats_org_user_last_msg_idx")
      .on(t.organizationId, t.userId, t.lastMessageAt.desc())
      .where(sql`${t.deletedAt} is null`),
  ]
);

/**
 * Live transport state the frontend needs to resume a chat on first paint,
 * keyed by chatId. Separate from `chats` so the secret token is isolated from
 * list queries and the hot per-turn write stays off the conversation row.
 *
 * No `userId` here on purpose: the agent's `onTurnComplete` event doesn't carry
 * `clientData`, and ownership is already enforced via the `chats` row — the
 * resume query joins `chats` to scope by owner (see `getSession`).
 */
export const chatSessions = dashboardAgentSchema.table("chat_sessions", {
  chatId: text("chat_id").primaryKey(), // = chats.id (FK-free, cross-db)
  publicAccessToken: text("public_access_token").notNull(),
  lastEventId: text("last_event_id"),
  runId: text("run_id"), // telemetry / "view this run"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per evaluated turn, written by the `dashboard-agent-eval-turn` task
 * that the agent triggers from `onTurnComplete`. Two kinds of data: quality
 * scores (did the agent answer well, grounded in its tool results) and insight
 * classification (what the user wanted, whether we have a product/docs/support
 * gap). Append-only analytics; the higher-level views ("top capability gaps",
 * "what users struggle with") are aggregations over these rows, not stored here.
 *
 * Structured columns are the things we filter, alert, and chart on; the evolving
 * taxonomy (typed `signals`) and the raw judge output live in JSONB so adding a
 * signal type is never a migration. Org + user scoped, FK-free (cross-db), with
 * a composite `(chatId, turn)` key so a re-delivered turn can't double-insert.
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
    // Operational + model. `promptVersion` lets a quality drop be attributed to a
    // dashboard-managed prompt edit that never went through CI.
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
    // Insight classification — the filterable summary of `signals`.
    intentCategory: text("intent_category"),
    outcome: text("outcome"), // resolved | partial | unresolved | deflected
    sentiment: text("sentiment"),
    capabilityGap: boolean("capability_gap").notNull().default(false),
    docsGap: boolean("docs_gap").notNull().default(false),
    supportOpportunity: boolean("support_opportunity").notNull().default(false),
    featureRequest: boolean("feature_request").notNull().default(false),
    // Rich / evolving.
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    signals: jsonb("signals").$type<unknown[]>().notNull().default([]),
    summary: text("summary"),
    userText: text("user_text"), // the user's question (clustering input)
    judge: jsonb("judge").$type<Record<string, unknown>>(), // full raw verdict
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.turn] }),
    // "what happened in this org lately", recent first.
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
 * One row per investigation — the agent's structured, revisioned working state
 * for a diagnostic thread. The primary key is the `investigationId` on purpose:
 * a follow-up turn (or another chat's handoff) can load an investigation from the
 * id alone, without knowing which chat it belongs to.
 *
 * `state` is deliberately untyped JSONB: the payload shape is still moving, and
 * pinning a `$type` here would make every shape change a migration. The
 * projectRef/environmentRef pair is the tenancy check for every write — a
 * revision bump must come from the same chat, project and environment that
 * created the investigation.
 *
 * `projectRef` is the project's **external** ref (`proj_…`), the same identifier
 * the `trigger://` URI scheme uses. `environmentRef` is `RuntimeEnvironment.id`.
 * Both are main-DB ids with no FK (cross-db).
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
    // "the investigations in this chat" (sidebar / follow-up context).
    index("investigations_chat_idx").on(t.chatId),
  ]
);

/** `active` is the only non-terminal status; the other three are immutable. */
export type WatchStatus = "active" | "fired" | "expired" | "cancelled";
/**
 * `not_required` while active and for every cancelled outcome — only fired/expired
 * notify. `delivering` is the in-flight claim: one deliverer at a time, so two
 * concurrent invocations can't both wake the chat (see `claimWatchDelivery`).
 */
export type WatchDeliveryStatus = "not_required" | "pending" | "delivering" | "delivered";
export type WatchCancelReason = "user" | "access_revoked" | "chat_deleted";

/**
 * The persisted spec adds a server-set `since` to the caller's spec. It's the
 * watch's creation time (ISO), used by `error_recurrence` so a recurrence check
 * can't match errors that predate the watch. Stored inside the JSONB rather than
 * as a column because it's part of the check's input, not watch lifecycle state.
 */
export type PersistedWatchSpec = WatchSpec & { since?: string };

/**
 * One row per watch — "tell me when X happens", checked by a periodic task.
 *
 * The initiating identity (`organizationId` / `projectId` / `environmentId` /
 * `userId`) is a **snapshot taken at creation and never updated**: a watch fires
 * with exactly the access its creator had, so a later membership change can only
 * cancel it (`cancel_reason = 'access_revoked'`), never silently widen its scope.
 * These are main-DB ids, FK-free (cross-db).
 *
 * `identity` is the caller-computed dedup key for the watched thing (e.g. the run
 * id or queue being watched) — its own column so the "already watching this"
 * lookup is a plain indexed query instead of a JSONB dig.
 *
 * Status/delivery transitions are guarded in the query layer with
 * `WHERE status = 'active' … RETURNING`, not by DB constraints, so a concurrent
 * fire/expire/cancel resolves to exactly one winner.
 */
export const watches = dashboardAgentSchema.table(
  "watches",
  {
    id: text("id").primaryKey(), // = watchId (`watch_…`)
    chatId: text("chat_id").notNull(), // = chats.id
    // Dedup key component: what is being watched, as a string.
    identity: text("identity").notNull(),
    spec: jsonb("spec").$type<PersistedWatchSpec>().notNull(),
    status: text("status").$type<WatchStatus>().notNull().default("active"),
    deliveryStatus: text("delivery_status")
      .$type<WatchDeliveryStatus>()
      .notNull()
      .default("not_required"),
    cancelReason: text("cancel_reason").$type<WatchCancelReason>(),
    // Immutable initiating identity — snapshot at creation.
    organizationId: text("organization_id").notNull(),
    projectId: text("project_id").notNull(),
    environmentId: text("environment_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    // When the current deliverer claimed the wake. A claim older than the
    // delivery grace is treated as abandoned and may be re-claimed.
    deliveryClaimedAt: timestamp("delivery_claimed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // The last check's output; on fire/expire it's the payload the notification uses.
    lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
    // Ticks so far. Check idempotency keys are `watch:{id}:tick:{n}`.
    tickCount: integer("tick_count").notNull().default(0),
  },
  (t) => [
    index("watches_chat_idx").on(t.chatId),
    // Guardrails + dedup: "the active watches in this chat" (max 3, and is this
    // thing already watched). Partial so terminal rows never bloat the hot path.
    //
    // UNIQUE is the actual dedup guarantee: a read-then-insert check can't be
    // race-proof under READ COMMITTED (two transactions both see no duplicate and
    // both insert), so the constraint has to live in the DB. Partial on `active`
    // because re-watching the same thing after a watch fired must be allowed.
    // Leading `chat_id` means this also serves the "active watches of this chat"
    // lookup, so no separate non-unique partial index is needed.
    uniqueIndex("watches_chat_active_identity_key")
      .on(t.chatId, t.projectId, t.environmentId, t.identity)
      .where(sql`${t.status} = 'active'`),
    // Sweep: active watches due to be checked / past their expiry.
    index("watches_status_expires_idx").on(t.status, t.expiresAt),
    // The other half of the sweep: resolved watches whose wake is still owed —
    // never claimed, or claimed by a deliverer that died mid-flight. Partial,
    // because "owed" is a handful of rows at any moment.
    index("watches_pending_delivery_idx")
      .on(t.firedAt, t.lastCheckedAt)
      .where(sql`${t.deliveryStatus} in ('pending', 'delivering')`),
  ]
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

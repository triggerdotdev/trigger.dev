import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { dashboardAgentSchema } from "./schema-base.js";

// drizzle-kit reads this file, so the watch tables are re-exported here: the
// generated SQL and the public surface stay exactly as they were.
export * from "./schema-base.js";
export * from "./watch-schema.js";

/**
 * Scoped to org + user. `organizationId` and `userId` are main-DB ids with no FK:
 * in cloud this table lives in a different database.
 *
 * No FK means no cascade: a new chatId-keyed table must be added to `deleteChatsByIds`
 * in queries.ts, or its rows leak when a chat is hard-deleted.
 */
export const chats = dashboardAgentSchema.table(
  "chats",
  {
    // = the Session externalId.
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull().default("New chat"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * @deprecated The transcript lives in `chat_messages`. Declared so drizzle doesn't
     * offer to drop it: whatever a deployed environment already wrote stays readable
     * until someone decides it isn't needed. Nothing reads or writes it.
     */
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    // NULL means never read, so everything in the chat counts as unread.
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    // The position allocator for `chat_messages`. Bumped by the same single statement
    // that reads it, so concurrent writers get disjoint contiguous ranges.
    nextMessagePosition: integer("next_message_position").notNull().default(1),
    /** The chat.agent runtime's opaque transcript state, written through the TranscriptStorage adapter. */
    transcriptState: jsonb("transcript_state").$type<unknown>(),
    /** The stream resume cursors the TranscriptStorage adapter was last handed. */
    transcriptCursors: jsonb("transcript_cursors").$type<{
      lastOutEventId?: string;
      lastInEventId?: string;
    }>(),
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
 * One row per message. Never rewritten wholesale: a new message is an insert, a repeat
 * of the same `messageId` is a no-op, and finalising one message updates only that row.
 *
 * `position` orders the transcript and comes from `chats.next_message_position`; it is
 * unique per chat, which is what makes a lost or duplicated allocation impossible rather
 * than unlikely. `role` is lifted out of the payload so the quota count is an index scan.
 */
export const chatMessages = dashboardAgentSchema.table(
  "chat_messages",
  {
    chatId: text("chat_id").notNull(), // = chats.id (FK-free, cross-db)
    // = the UI message's own `id`, so a redelivered write is a conflict, not a duplicate.
    messageId: text("message_id").notNull(),
    position: integer("position").notNull(),
    role: text("role").notNull(),
    message: jsonb("message").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.messageId] }),
    unique("chat_messages_chat_position_key").on(t.chatId, t.position),
    // Covers the quota count without touching the heap.
    index("chat_messages_chat_user_role_idx")
      .on(t.chatId, t.messageId)
      .where(sql`${t.role} = 'user'`),
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
    // Legacy, no longer written: both held the turn verbatim (the user's question, and the
    // judge's raw verdict with its reasoning). Kept only until no deployed agent writes them.
    userText: text("user_text"),
    judge: jsonb("judge").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.turn] }),
    index("chat_turn_evals_org_created_idx").on(t.organizationId, t.createdAt.desc()),
    // Retention scans by age across every org, so it can't use the org-leading index.
    index("chat_turn_evals_created_idx").on(t.createdAt),
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
    // Failed stale-sweep settle attempts. Bumped outside the rolled-back settle tx so a
    // row that can't render rotates to the back of the sweep order instead of pinning it.
    sweepAttempts: integer("sweep_attempts").notNull().default(0),
    lastSweepAttemptAt: timestamp("last_sweep_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("investigations_chat_idx").on(t.chatId),
    // The stale sweep, every 5 minutes. Partial, so it stays small in a table with no
    // retention: settled rows are the overwhelming majority.
    index("investigations_open_updated_idx")
      .on(t.updatedAt)
      .where(sql`${t.state}->>'outcome' = 'in_progress'`),
  ]
);

/**
 * Per-(org, period) message counter. Deliberately not joined to chats: deleting a chat
 * must not free quota inside the period. `period` is a UTC calendar month, "YYYY-MM".
 * Org id is a main-DB id with no FK.
 */
export const agentMessageUsage = dashboardAgentSchema.table(
  "agent_message_usage",
  {
    organizationId: text("organization_id").notNull(),
    period: text("period").notNull(),
    count: integer("count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.period] })]
);

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatTurnEval = typeof chatTurnEvals.$inferSelect;
export type NewChatTurnEval = typeof chatTurnEvals.$inferInsert;
export type Investigation = typeof investigations.$inferSelect;
export type NewInvestigation = typeof investigations.$inferInsert;
export type AgentMessageUsage = typeof agentMessageUsage.$inferSelect;
export type NewAgentMessageUsage = typeof agentMessageUsage.$inferInsert;

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
} from "drizzle-orm/pg-core";

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

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatTurnEval = typeof chatTurnEvals.$inferSelect;
export type NewChatTurnEval = typeof chatTurnEvals.$inferInsert;

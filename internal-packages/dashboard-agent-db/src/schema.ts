import { sql } from "drizzle-orm";
import { index, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

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

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;

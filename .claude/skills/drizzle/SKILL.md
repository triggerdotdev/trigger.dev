---
name: drizzle
description: Use this skill when writing or modifying Drizzle ORM schemas, queries, or migrations in this repo — specifically the `@internal/dashboard-agent-db` package (the dashboard agent's conversation datastore). Covers pg-core schema definition, the postgres-js driver, drizzle-kit migrations, and this repo's conventions: a dedicated Postgres schema, foreign-key-free cross-database design, pooler-safe connections, and the access-pattern query layer. Drizzle is NOT the main database — that's Prisma.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Drizzle ORM (this repo)

Drizzle is used in exactly one place: **`internal-packages/dashboard-agent-db`** (`@internal/dashboard-agent-db`), the in-dashboard agent's conversation store. Everything else in the monorepo is **Prisma** (`@trigger.dev/database`). Keep them separate.

Pinned versions: **`drizzle-orm` ^0.45**, **`drizzle-kit` ^0.31** (dev), **`postgres` ^3.4** (postgres.js driver). drizzle-orm and drizzle-kit are intentionally on different version lines — 0.31.x is the correct companion for 0.45.x, there is no peer dependency between them.

## Critical rules

1. **Drizzle is only the agent's own datastore.** The agent (and its task bundle) must have **no access to the main Prisma database or ClickHouse**. Never import the Prisma client into the agent task or into `@internal/dashboard-agent-db`. Main data is reached via the API, not Drizzle.
2. **Foreign-key-free.** In cloud this DB is a *separate* PlanetScale database, so it can't FK into the main DB. Reference main entities (`organizationId`, `userId`, …) **by id only — never `.references()`**. Joins happen in app code; tenant scoping is enforced in the query layer.
3. **One dedicated Postgres schema.** All tables live under `pgSchema("trigger_dashboard_agent")` so they're schema-qualified and isolated from Prisma's `public` schema (this is what makes the OSS single-database fallback safe).
4. **Pooler-safe connections.** Connections go through a transaction-mode pooler (PlanetScale / PgBouncer-style), so postgres.js must run with **`prepare: false`** — prepared statements don't survive a connection being handed to another client between checkouts.
5. **Node16 module resolution.** Relative imports need explicit **`.js`** extensions (`import { chats } from "./schema.js"`), even though the source is `.ts`.
6. **Scope every user query.** All queries that touch user data go through `src/queries.ts` and are scoped by `organizationId` / `userId`, so callers can't forget the `where`. Don't write ad-hoc cross-tenant queries elsewhere.

## Package layout

```
internal-packages/dashboard-agent-db/
  drizzle.config.ts      # drizzle-kit config (schema path, out dir, schemaFilter)
  drizzle/               # generated migrations (committed)
  src/
    schema.ts            # pgSchema + table definitions
    client.ts            # createDashboardAgentDb() — postgres.js + drizzle
    queries.ts           # the access-pattern layer (org/user-scoped)
    index.ts             # barrel: re-exports schema, client, queries
```

`package.json` points `main`/`types` at `./src/index.ts` (consumed as source, no build step) — same as other simple internal packages.

## Schema (pg-core)

Use `pgSchema(...).table(...)`, not the bare `pgTable`, so tables land in the dedicated schema. ([schemas](https://orm.drizzle.team/docs/schemas), [pg column types](https://orm.drizzle.team/docs/column-types/pg), [indexes](https://orm.drizzle.team/docs/indexes-constraints))

```ts
import { sql } from "drizzle-orm";
import { index, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

export const dashboardAgentSchema = pgSchema("trigger_dashboard_agent");

export const chats = dashboardAgentSchema.table(
  "chats",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(), // FK-free: id only, no .references()
    userId: text("user_id").notNull(),
    title: text("title").notNull().default("New chat"),
    // JSONB with a typed view; .default([]) / .default({}) emit '[]'::jsonb / '{}'::jsonb
    messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Extra config returns an ARRAY in drizzle-orm 0.36+ (not an object).
  (t) => [
    // Partial + ordered composite index. `.desc()` on the column, `.where(sql`...`)` for partial.
    index("chats_org_user_last_msg_idx")
      .on(t.organizationId, t.userId, t.lastMessageAt.desc())
      .where(sql`${t.deletedAt} is null`),
  ]
);

// Inferred row types for the query layer + consumers.
export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
```

Notes:
- `timestamp(..., { withTimezone: true })` → `timestamp with time zone`. Use `.defaultNow()` for `DEFAULT now()`.
- For a "newest first, nulls last" sort the partial index uses `.desc()`; the *query* uses raw `sql` for `NULLS LAST` (see below).
- Don't add `.references()` — see critical rule 2.

## Client (postgres.js + drizzle)

([connect overview](https://orm.drizzle.team/docs/connect-overview)) One small pool, `prepare: false`. In the agent task create it once in `onBoot` (per-process); in the webapp wrap it in the `singleton(...)` helper.

```ts
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type DashboardAgentDb = PostgresJsDatabase<typeof schema>;

export function createDashboardAgentDb(connectionString: string, opts: { max?: number } = {}) {
  const sql: Sql = postgres(connectionString, {
    max: opts.max ?? 5,        // small — the pooler does the real pooling
    idle_timeout: 20,          // release conns when an agent run suspends
    prepare: false,            // REQUIRED for transaction-mode poolers
  });
  return { db: drizzle(sql, { schema }), sql, close: () => sql.end() };
}
```

## Queries (the access-pattern layer)

([select](https://orm.drizzle.team/docs/select), [insert](https://orm.drizzle.team/docs/insert), [operators](https://orm.drizzle.team/docs/operators), [transactions](https://orm.drizzle.team/docs/transactions), [joins](https://orm.drizzle.team/docs/joins))

```ts
import { and, desc, eq, isNull, sql } from "drizzle-orm";

// Select EXPLICIT columns for list views — never select a large blob (messages)
// or a secret (tokens) you don't need. `NULLS LAST` needs raw sql in orderBy.
await db
  .select({ id: chats.id, title: chats.title, lastMessageAt: chats.lastMessageAt })
  .from(chats)
  .where(and(eq(chats.organizationId, orgId), eq(chats.userId, userId), isNull(chats.deletedAt)))
  .orderBy(sql`${chats.pinnedAt} desc nulls last`, desc(chats.lastMessageAt))
  .limit(50);

// Idempotent create (avoids a duplicate-key race between two writers).
await db.insert(chats).values({ id, organizationId: orgId, userId }).onConflictDoNothing();

// Upsert.
await db
  .insert(chatSessions)
  .values({ chatId, publicAccessToken })
  .onConflictDoUpdate({ target: chatSessions.chatId, set: { publicAccessToken, updatedAt: sql`now()` } });

// Owner-scope a join (this DB is FK-free, so enforce ownership in the query).
await db
  .select({ /* session cols */ })
  .from(chatSessions)
  .innerJoin(chats, eq(chats.id, chatSessions.chatId))
  .where(and(eq(chatSessions.chatId, chatId), eq(chats.userId, userId)));

// Multi-write that must be consistent on the next read → one transaction.
await db.transaction(async (tx) => {
  await tx.update(chats).set({ messages, updatedAt: sql`now()` }).where(eq(chats.id, chatId));
  await tx.insert(chatSessions).values({ /* ... */ }).onConflictDoUpdate({ /* ... */ });
});
```

Use `sql\`now()\`` for DB-side timestamps in updates.

## Migrations (drizzle-kit)

([kit overview](https://orm.drizzle.team/docs/kit-overview), [generate](https://orm.drizzle.team/docs/drizzle-kit-generate), [migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate))

`drizzle.config.ts` must set **`schemaFilter`** so drizzle-kit only ever manages our schema — never Prisma's `public` (critical in the OSS single-DB fallback):

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["trigger_dashboard_agent"],
  dbCredentials: { url: process.env.DASHBOARD_AGENT_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://placeholder" },
});
```

Workflow:

```bash
cd internal-packages/dashboard-agent-db
pnpm run db:generate   # diff schema.ts → emit SQL into drizzle/. OFFLINE (no DB needed).
#   review the generated drizzle/000N_*.sql before committing
pnpm run db:migrate    # apply pending migrations. Needs a real DATABASE URL.
```

- `db:generate` is **offline** — it only reads `schema.ts`, so you can verify a schema change compiles to valid DDL with no database. Use it as a fast check.
- drizzle-kit names migration files with a **random suffix** (`0000_magenta_lilandra.sql`). Don't regenerate a committed migration just to "refresh" it — that churns the filename. After the first migration is committed, schema changes produce a **new** `000N_*.sql`; commit that.
- Generated DDL for a new schema is one `CREATE SCHEMA` + schema-qualified `CREATE TABLE`s + indexes, **no foreign keys** (by design here).

## Common gotchas

- **`prepare: false`** is not optional with a pooler — without it you'll get prepared-statement errors under load.
- **Missing `.js` extension** on a relative import → TS2835 under Node16 resolution.
- **Extra-config callback returns an array** `(t) => [ ... ]` in drizzle-orm 0.36+. The old object form `(t) => ({ ... })` is deprecated.
- **`NULLS LAST` / `NULLS FIRST`** aren't on the `desc()` helper — use raw `sql\`col desc nulls last\`` in `orderBy`.
- **Don't `SELECT *` into list views** — explicitly pick columns so you never ship a megabyte `messages` blob or a session token to a list query.
- **Adding a dependency**: edit `package.json`, then `pnpm i` from the repo root (never `pnpm add`). Mind the repo's `minimumReleaseAge` (3 days) — pin with a caret range and let pnpm resolve an old-enough version.

## Reference (official docs)

- Schema declaration — https://orm.drizzle.team/docs/sql-schema-declaration
- PostgreSQL column types — https://orm.drizzle.team/docs/column-types/pg
- Schemas (`pgSchema`) — https://orm.drizzle.team/docs/schemas
- Indexes & constraints — https://orm.drizzle.team/docs/indexes-constraints
- Connect (postgres-js) — https://orm.drizzle.team/docs/connect-overview
- Select / Insert / Update / Delete — https://orm.drizzle.team/docs/select · /insert · /update · /delete
- Joins / Operators — https://orm.drizzle.team/docs/joins · /operators
- Transactions — https://orm.drizzle.team/docs/transactions
- drizzle-kit (generate / migrate / push) — https://orm.drizzle.team/docs/kit-overview

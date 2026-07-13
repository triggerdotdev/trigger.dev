# @internal/dashboard-agent-db

The conversation datastore for the in-dashboard agent, isolated from the main
Prisma database. Drizzle (postgres-js) over a dedicated `trigger_dashboard_agent`
Postgres schema.

- **Cloud:** a separate PlanetScale Postgres database. The app connects over a
  pooled connection (`DASHBOARD_AGENT_DATABASE_URL`); migrations run over a direct
  (non-pooler) connection (`DASHBOARD_AGENT_DIRECT_URL`), since a transaction-mode
  pooler can't run the migrator.
- **OSS / self-host:** falls back to the main `DATABASE_URL` (and `DIRECT_URL` for
  migrations); the tables live in the dedicated `trigger_dashboard_agent` schema,
  isolated from Prisma's `public`.

The schema is **foreign-key-free** — it references main entities (`organizationId`,
`userId`) by id only, because in cloud it lives in a different database.

## Why a separate store

The agent runs as an ephemeral Trigger task and must have **no access to the main
database or ClickHouse** (those go through the API). This is its own low-blast-radius
store: the agent connects directly here to persist conversations, and the webapp
connects here for the History tab. Conversation history *correctness* is owned by
`chat.agent`'s built-in object-store snapshot — this DB is a display read-model
(list chats, render a past chat, resume the transport), never the model's source
of truth.

## Tables

- `chats` — one row per conversation: org/user scope, title, a `messages` JSONB
  display copy of the transcript, and `metadata` (the project/env context the chat
  ran in). Soft-deleted via `deleted_at`, pinned via `pinned_at`.
- `chat_sessions` — live transport state keyed by `chat_id`: the session-scoped
  `public_access_token` and `last_event_id` for resume. Separate table so the
  secret token is isolated from list queries and the hot per-turn write stays off
  the conversation row's indexes.

## Migrations

```bash
pnpm run db:generate   # generate SQL migration from src/schema.ts (offline)
pnpm run db:migrate    # apply migrations (direct url: DASHBOARD_AGENT_DIRECT_URL, falling back to DASHBOARD_AGENT_DATABASE_URL / DIRECT_URL / DATABASE_URL)
```

drizzle-kit is scoped to the `trigger_dashboard_agent` schema (`schemaFilter`), so
pointing it at the main OSS database never touches Prisma's tables.

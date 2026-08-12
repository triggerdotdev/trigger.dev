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

- `chats` — one row per conversation: org/user scope, title, `metadata` (the
  project/env context the chat ran in), and `next_message_position`, the allocator the
  transcript's ordering comes from. No transcript of its own. Soft-deleted via
  `deleted_at`, pinned via `pinned_at`, read-marked via `last_read_at` (NULL = never
  read, so every watch wake in it counts as unread).
- `chat_messages` — the transcript, one row per message. Identity is
  `(chat_id, message_id)` and order is `position`, unique per chat and reserved from
  `chats.next_message_position` by the same single statement that reads it, so
  concurrent writers get disjoint contiguous ranges. `role` is lifted out of the
  payload so the message-quota count is an index scan.

  Three write modes, and only the third may change a message the chat already holds:
  a new message is a plain insert; a redelivered durable event (a watch wake, a
  settlement card) is `ON CONFLICT DO NOTHING` on `(chat_id, message_id)`, so it
  leaves the recorded row untouched; a deliberate finalisation is
  `finalizeChatMessage`, which rewrites one body under a verified `role` and never
  moves the id or the position. So re-sending a whole turn snapshot is a no-op.

  Positions are monotonic, not gapless: a reservation whose insert then conflicts,
  or a batch that rolls back, leaves the slot unused. Only the relative order
  matters, so a gap is expected and harmless.
- `chat_sessions` — live transport state keyed by `chat_id`: the session-scoped
  `public_access_token` and `last_event_id` for resume. Separate table so the
  secret token is isolated from list queries and the hot per-turn write stays off
  the conversation row's indexes.
- `chat_turn_evals` — one row per judged turn, written by the
  `dashboard-agent-eval-turn` task: quality scores (grounded / answered / concise)
  and insight classification (intent, outcome, capability & docs gaps). Keyed on
  `(chat_id, turn)` so a re-delivered turn can't double-insert. A row holds the
  judge's derived verdict only — never the user's question, the agent's answer or
  any tool data. What is judged and what a row may carry is one file:
  `@internal/dashboard-agent/src/eval-policy.ts`. Rows are retired after 30 days
  by the webapp's dashboard-agent sweep. `user_text` and `judge` are legacy
  columns nothing writes any more.
- `investigations` — the agent's revisioned working state for a diagnostic thread.
  Keyed by `investigation_id` so a follow-up can load one from the id alone;
  `revision` is bumped by a single atomic `revision = revision + 1` update, and the
  `chat_id`/`project_ref`/`environment_ref` triple must match on every commit.
  `state` is intentionally untyped JSONB — the payload shape isn't frozen yet.
- `watches` — "tell me when X happens", checked by a periodic task. `status`
  (`active | fired | expired | cancelled`) and `delivery_status`
  (`not_required | pending | delivering | delivered`) are guarded in the query layer with
  `WHERE status = 'active' … RETURNING`, so concurrent fire/expire/cancel resolves
  to one winner. The org/project/env/user identity is a snapshot taken at creation
  and never updated — a watch fires with exactly the access its creator had.
  `identity` is the dedup key for the watched thing: a partial unique index on
  `(chat_id, project_id, environment_id, identity) WHERE status = 'active'` is what
  actually prevents duplicates, since a read-then-insert check can't be race-proof.
  A chat may hold at most three active watches, enforced by counting and inserting
  in one transaction under a per-chat advisory lock.

## Migrations

```bash
pnpm run db:generate   # generate SQL migration from src/schema.ts (offline)
pnpm run db:migrate    # apply migrations (direct url: DASHBOARD_AGENT_DIRECT_URL, falling back to DASHBOARD_AGENT_DATABASE_URL / DIRECT_URL / DATABASE_URL)
```

drizzle-kit is scoped to the `trigger_dashboard_agent` schema (`schemaFilter`), so
pointing it at the main OSS database never touches Prisma's tables.

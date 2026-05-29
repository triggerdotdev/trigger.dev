# AI Chat Reference App

A multi-turn chat app built with the AI SDK's `useChat` hook and Trigger.dev's `chat.task`. Conversations run as durable Trigger.dev tasks with realtime streaming, automatic message accumulation, and persistence across page refreshes.

## Data Models

### Chat

The conversation itself — your application data.

| Column     | Description                              |
| ---------- | ---------------------------------------- |
| `id`       | Unique chat ID (generated on the client) |
| `title`    | Display title for the sidebar            |
| `messages` | Full `UIMessage[]` history (JSON)        |

A Chat lives forever (until the user deletes it). It is independent of any particular Trigger.dev run.

### ChatSession

The transport's connection state for a chat — what the frontend needs to reconnect to the same Trigger.dev run after a page refresh.

| Column              | Description                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `id`                | Same as the chat ID (1:1 relationship)                                      |
| `runId`             | The Trigger.dev run handling this conversation                              |
| `publicAccessToken` | Scoped token for reading the run's stream and sending input stream messages |
| `lastEventId`       | Stream position — used to resume without replaying old events               |

A Chat can outlive many ChatSessions. When the run ends (turn timeout, max turns reached, crash), the ChatSession is gone but the Chat and its messages remain. The next message from the user starts a fresh run and creates a new ChatSession for the same Chat.

**Think of it as: Chat = the conversation, ChatSession = the live connection to the run handling it.**

## Lifecycle Hooks

Persistence is handled server-side in the Trigger.dev task via three hooks:

- **`onChatStart`** — Creates the Chat and ChatSession records when a new conversation starts (turn 0).
- **`onTurnStart`** — Saves messages and updates the session _before_ streaming begins, so a mid-stream page refresh still shows the user's message.
- **`onTurnComplete`** — Saves the assistant's response and the `lastEventId` for stream resumption.

## Setup

This reference assumes you already have the local webapp running per the repo's [`CONTRIBUTING.md`](../../CONTRIBUTING.md) (Docker services, `pnpm run db:migrate`, `pnpm run db:seed`, webapp on `:3030`).

Unlike `hello-world`, the ai-chat project is **not** in the webapp seed. You'll need to create it manually:

1. Open http://localhost:3030, log in, switch to the `References` org, and create a new project called `ai-chat`.
2. Grab the project ref (`proj_...`) from the URL and a Dev secret key from the project's API keys page.
3. Set up this app's env and database:

   ```bash
   cd references/ai-chat
   cp .env.example .env
   # Fill in TRIGGER_PROJECT_REF, TRIGGER_SECRET_KEY,
   # NEXT_PUBLIC_TRIGGER_PROJECT_DASHBOARD_PATH, and at least one
   # of OPENAI_API_KEY / ANTHROPIC_API_KEY.
   npx prisma migrate deploy
   ```

   The `DATABASE_URL` in `.env.example` points at the local Postgres started by `pnpm run docker` and uses a separate `ai_chat` database.

## Running

Three terminals from the repo root:

```bash
# 1. Webapp (if not already running)
pnpm run dev --filter webapp

# 2. Trigger CLI dev (registers the chat tasks with the local webapp)
cd references/ai-chat && pnpm exec trigger dev

# 3. Next.js dev server for the chat UI
cd references/ai-chat && pnpm run dev
```

Open http://localhost:3000 to use the chat app.

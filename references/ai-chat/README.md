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

```bash
# From the repo root
pnpm run docker              # Start PostgreSQL, Redis, Electric
pnpm run db:migrate          # Run webapp migrations
pnpm run db:seed             # Seed the database

# Set up the reference app's database
cd references/ai-chat
cp .env.example .env         # Edit DATABASE_URL if needed
npx prisma migrate deploy

# Build and run
pnpm run build --filter trigger.dev --filter @trigger.dev/sdk
pnpm run dev --filter webapp  # In one terminal
cd references/ai-chat && pnpm exec trigger dev  # In another
cd references/ai-chat && pnpm run dev            # In another
```

Open http://localhost:3000 to use the chat app.

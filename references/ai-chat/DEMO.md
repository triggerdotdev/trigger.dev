# AI Chat Demo Script (5-7 min)

**Setup:** Three windows ready — ai-chat app (localhost:3000), Trigger.dev dashboard, VS Code with chat.ts open (all regions collapsed).

**Audience:** PostHog event

**Pitch:** Trigger.dev started as a workflow engine for async background tasks, but more and more people are using us to build full chat agents. We've built a deep integration with the AI SDK's useChat hook that connects a single chat to a single persisted, isolated, fully customizable execution environment with two-way communication.

---

## 1. New chat — preloading (1 min)

**Open localhost:3000. Click "New Chat".**

> I haven't typed anything yet. But flip to the dashboard —

**Switch to dashboard. Show the run that just started.**

> There's already a run executing. This is preloading. When the user opens the chat page, the frontend calls `transport.preload()` which triggers the task immediately. It loaded the user from the DB, resolved the system prompt, created the chat record — all before the first keystroke. Imagine this in something like PostHog's AI product assistant — when a user opens the chat, you want the agent ready instantly, not cold-starting while they wait.

**Point to the "waiting for first message" span.**

---

## 2. First message + live analytics query (1.5 min)

**Switch back to chat. Type: "What are the top events on our PostHog instance this week?"**

> Now the first turn starts — and watch, it's going to call the posthogQuery tool. This tool writes a HogQL query and runs it against our actual PostHog instance — this is our real Trigger.dev analytics data.

**Watch the tool call + results stream back.**

> It wrote the query, executed it, and summarized the results — all in one turn.

**Switch to dashboard, show turn 1 span with the tool call.**

> Here's the lifecycle — onTurnStart persisted the message, run() called streamText, the LLM decided to use the posthogQuery tool, got the results, and generated a response. After the turn completes, the run doesn't end — it waits for the next message. Same process, same memory.

---

## 3. Follow-up — incremental sends + persistent state (45s)

**Switch back to chat. Send: "How does that compare to last week?" or "Which of those are custom events vs autocapture?"**

**Switch to dashboard, show turn 2.**

> Turn 2 — the frontend only sent the new user message, not the full conversation. The backend already has the accumulated context. It knows what "those" refers to because it's the same execution environment. For a product analytics assistant where users iteratively drill into their data, this is huge — no context lost between turns.

---

## 4. Idle, suspend, resume (30s)

> After 60 seconds of no messages, the run snapshots its state and suspends. Zero compute while the user is away. When they come back — maybe they went to check their PostHog dashboard based on what the agent told them and came back with a follow-up — we restore from the snapshot and continue. Same run, same state.

**Point to the "suspended" span in the trace if visible.**

---

## 5. Tool subtasks (1 min)

**Switch back to chat. Send: "Can you research what's new with PostHog lately?"**

> Now it's using the deepResearch tool — this one is different. It's a separate Trigger.dev task running in its own container, fetching multiple URLs and streaming progress back to the chat in real time. You could have tools for querying PostHog, tools for checking feature flags, tools for pulling session recordings — and the heavy ones run as subtasks with their own retries and traces.

**Show the trace — triggerAndSubscribe span with child run nested inside.**

> The parent subscribes to the child via realtime. If the user hits stop, the child gets cancelled automatically.

---

## 6. The code (1.5 min)

**Switch to VS Code with chat.ts, all regions collapsed.**

> This is the whole thing — one file. A chat.task with lifecycle hooks and a run function.

Point out the collapsed view:

- `idleTimeoutInSeconds`, `clientDataSchema` — typed metadata from the frontend
- `onPreload` — that's what fired before the first message
- `onTurnStart`, `onTurnComplete` — persistence hooks
- `run` — just `return streamText()`. The SDK handles everything else.

**Expand the run region.**

> Messages come in already converted. You return streamText. The posthogQuery tool is just a plain AI SDK tool that calls the PostHog API — deepResearch is a subtask wrapped with ai.tool. Mix and match.

**Expand onTurnComplete if time.**

> After every turn we defer a background call to gpt-4o-mini that reviews the response with generateObject. If it finds improvements, chat.inject adds a system message before the next LLM call. The agent gets coaching between turns — and it doesn't block the user.

---

## 7. Wrap up (15s)

> One chat, one persistent run. Lifecycle hooks, streaming, tool subtasks, background self-improvement — all on Trigger.dev's infrastructure with snapshot/restore and full observability. This is available now in the SDK.

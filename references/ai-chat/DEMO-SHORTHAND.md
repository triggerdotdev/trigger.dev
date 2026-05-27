# Demo Cheat Sheet

## Pitch
- Started as workflow engine, now people building chat agents
- Deep AI SDK useChat integration
- One chat = one persistent isolated execution environment
- Two-way communication

## 1. Preloading
- Click New Chat, DON'T type anything
- Flip to dashboard — run already executing
- "waiting for first message" span
- Zero cold start

## 2. First message — PostHog query
- "What are the top events on our PostHog instance this week?"
- Watch posthogQuery tool call
- Real data, real HogQL
- Show trace: onTurnStart → run → tool call → response
- Run stays alive after turn

## 3. Follow-up — incremental
- "Which of those are custom events vs autocapture?"
- Only new message sent, not full history
- Backend has context in memory
- Same execution environment

## 4. Suspend/resume
- 60s idle → snapshot → suspend → zero compute
- Next message → restore → continue
- Same run, same state

## 5. Tool subtasks
- "Can you research what's new with PostHog lately?"
- deepResearch = separate task, own container
- Streams progress back to chat
- Show trace: triggerAndSubscribe → child run
- Stop cancels child automatically

## 6. Code
- All regions collapsed — show the skeleton
- idleTimeoutInSeconds, clientDataSchema
- Hooks: onPreload, onTurnStart, onTurnComplete, run
- Expand run: just return streamText()
- Expand onTurnComplete: background self-review, chat.inject()

## Wrap
- One chat, one persistent run
- Lifecycle hooks, streaming, subtasks, background injection
- Snapshot/restore, full observability
- Available now

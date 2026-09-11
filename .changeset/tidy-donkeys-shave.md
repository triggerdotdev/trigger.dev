---
"@trigger.dev/sdk": patch
---

Reloading a chat while the agent is still answering now shows the message being answered. Previously the incoming message was only persisted once the turn finished, so a refresh mid-answer showed the reply arriving with no question above it.

Adds `chat.deferBeforeOutput()` for app-owned writes that the next page load has to see. Like `chat.defer()` the work is not awaited by the hook that registers it, so it runs alongside the model and costs no time to first token, but the answer is held until it lands. Use it for the conversation or message write you previously had to `await` in `onTurnStart`, as long as nothing else in the turn reads that write back: it orders the write against what the frontend can see, not against the model, so a tool that reads the same row still needs an awaited write.

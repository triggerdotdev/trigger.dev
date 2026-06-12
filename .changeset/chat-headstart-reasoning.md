---
"@trigger.dev/sdk": patch
---

Preserve reasoning parts across the `chat.headStart` handover. Extended-thinking models' step-1 reasoning now lands in the durable session history (and `onTurnComplete`) under the same assistant `messageId`, with provider metadata intact so Anthropic thinking signatures survive replays.

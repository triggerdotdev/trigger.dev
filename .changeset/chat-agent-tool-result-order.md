---
"@trigger.dev/sdk": patch
---

`chat.agent` now sends parallel tool results to the model in the order the tools were called, the same order the next turn's history uses. Models that bind their thinking to the exact conversation (Claude Sonnet 5.5, Claude Opus 5.5, Claude Fable 5.1) no longer lose a turn's reasoning, or fail the request on accounts that enforce the check, when its tools finish out of order.

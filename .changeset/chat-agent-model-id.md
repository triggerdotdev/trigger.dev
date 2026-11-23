---
"@trigger.dev/sdk": patch
---

The chat agent skills shipped in the SDK and the dashboard's new-project chat agent snippet now use `claude-sonnet-5-5` instead of `claude-sonnet-4-5`. Anthropic retires `claude-sonnet-4-5` on November 30, 2026; agents generated from these templates would fail on the first turn after that date.

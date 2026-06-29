---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` / `AgentChat` when the agent is deployed to a Trigger.dev preview branch. The realtime message-append and stream-subscribe calls now send the `x-trigger-branch` header (sourced from the same resolver `sessions.start` uses), so messaging a preview-branch chat agent no longer fails with `x-trigger-branch header required for preview env`.

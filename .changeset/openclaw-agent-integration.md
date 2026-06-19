---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

feat: Add OpenClaw agent integration with Slack webhooks

Implements Phase 1 MVP for AI agent platform allowing users to create agents through setup form (/agents/setup). Agents are stored in database with configuration (model, platform, tools). Slack webhook receives messages and triggers agent responses. Includes agent management UI and webhook integration infrastructure.

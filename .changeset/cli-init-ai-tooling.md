---
"trigger.dev": patch
---

`trigger init` now sets up your AI coding assistant as part of project setup: pick the MCP server, the agent skills, or both, then scaffold with the CLI or hand off to your assistant. Adds a new `getting-started` agent skill that teaches assistants how to bootstrap Trigger.dev (install the SDK, write `trigger.config.ts`, create a first task, run `trigger dev`), so the AI-driven setup path works end to end. It ships in the CLI alongside the existing skills, version-matched to your SDK.

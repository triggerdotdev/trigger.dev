---
"trigger.dev": patch
---

Fix `chat.agent` skills silently missing in `trigger dev` for projects whose task files read `process.env` at module top level (e.g. a third-party SDK client initialized at import). Skill folders now bundle into `.trigger/skills/` reliably regardless of which env vars are set when the CLI launches.

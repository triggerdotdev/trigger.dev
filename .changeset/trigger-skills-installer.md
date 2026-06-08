---
"trigger.dev": patch
---

`trigger skills` installs Trigger.dev agent skills into your coding agent so it knows how to write tasks, schedules, realtime, and chat.agent code. The skills ship with the CLI and are copied into each tool's native skills directory (Claude Code, Cursor, GitHub Copilot, and Codex / AGENTS.md), and `trigger dev` offers to install them on first run.

```bash
trigger skills --target claude-code
```

Replaces the previous `install-rules` command, which stays as an alias.

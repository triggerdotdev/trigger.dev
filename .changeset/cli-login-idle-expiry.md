---
"trigger.dev": patch
---

Logins made with `trigger.dev login` or the MCP server now stop working after 7 days without use. When that happens, the CLI and the MCP server start a new login instead of failing with an auth error, and in CI the CLI says to log in again. Self-hosted instances can change the window with `CLI_LOGIN_IDLE_TIMEOUT_DAYS`, or set it to `0` to turn it off for new logins. Logins made before this change aren't affected.

---
"trigger.dev": patch
"@trigger.dev/core": patch
---

CLI and MCP logins are now bound to the machine that started them. Approving a login in your browser sends you back to the CLI automatically, or, when the browser is on another machine, shows a code to paste into the terminal (or pass with `trigger.dev login --code`). Older CLI versions will need to upgrade to log in.

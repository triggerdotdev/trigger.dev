---
"trigger.dev": patch
---

Fix `trigger deploy` hanging at 100% CPU in non-TTY CI environments. The deploy spinner ran every build-log message through `truncateMessage()`, which truncated large messages one character at a time while re-scanning the whole string with two ANSI regexes on each iteration (O(n²)), and truncated even when there was no terminal width to fit to. On the large messages a deploy emits this pegged a CPU core for many minutes on slower CI runners, so the deploy appeared to hang at "Deploying project". `truncateMessage` now returns the message unchanged when there is no terminal width (no TTY and no explicit max) and truncates in a single O(n) forward pass that preserves ANSI escape sequences.

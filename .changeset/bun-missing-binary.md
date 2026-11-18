---
"trigger.dev": patch
"@trigger.dev/core": patch
---

`trigger dev` and `trigger deploy` no longer crash with `spawn ... ENOENT` on bun runtimes when Bun isn't installed at `~/.bun`. The CLI now falls back to `bun` on your `PATH` (Homebrew, mise and similar installs), and if Bun still can't be started, `trigger dev` reports a readable error and `trigger deploy` skips local skill discovery with a warning and carries on.

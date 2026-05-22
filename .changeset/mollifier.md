---
"@trigger.dev/redis-worker": minor
"@trigger.dev/core": patch
---

Add mollifier — a Redis-backed burst buffer that absorbs trigger storms in front of `engine.trigger` and materialises them into Postgres at a controlled rate via a fair drainer.

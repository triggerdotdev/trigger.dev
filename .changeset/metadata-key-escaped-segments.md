---
"@trigger.dev/core": patch
---

Run metadata operations now reject JSON-path keys that use escaped dots to reach `__proto__`, `constructor` or `prototype`.

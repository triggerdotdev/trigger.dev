---
"trigger.dev": patch
---

Ensure the shared content-addressable store directory exists before writing so a second `trigger dev` session cannot crash after the previous session cleans it up.

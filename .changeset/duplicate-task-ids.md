---
"@trigger.dev/core": patch
"trigger.dev": patch
---

`dev` and `deploy` now fail with a clear error when two tasks are defined with the same id, including across different task types (e.g. a scheduled task and a regular task sharing an id). Previously the second definition silently overwrote the first, so one of the tasks would vanish with no warning. Task ids are detected as duplicates during indexing (naming each offending id and the files it was found in), and the same rule is enforced server-side when the background worker is registered.

---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Deployed tasks now keep a valid short-lived run token for their whole run: the token is refreshed during long runs and before a run resumes from a checkpoint. A warm-started task no longer keeps the previous run's token when the next run has none, and run credentials are left out of runner debug logs.

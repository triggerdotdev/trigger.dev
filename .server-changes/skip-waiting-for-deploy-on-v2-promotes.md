---
area: webapp
type: fix
---

Skip the legacy V1 `WAITING_FOR_DEPLOY` drain on V2 deployment promotions. A new `LEGACY_RUN_ENGINE_WAITING_FOR_DEPLOY_DISABLED` env var also acts as a kill-switch for any already-enqueued jobs.

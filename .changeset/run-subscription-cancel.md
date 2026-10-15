---
"@trigger.dev/core": patch
---

Fix run subscriptions crashing Node with `Controller is already closed` after you `break` out of the loop, and stop polling once you do. `ApiClient` subscribe methods also accept a custom `fetchClient`.

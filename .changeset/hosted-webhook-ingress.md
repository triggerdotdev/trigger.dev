---
"@trigger.dev/core": minor
"@trigger.dev/sdk": minor
"trigger.dev": minor
---

Add hosted webhooks: receive and verify provider webhooks as a task, with no ingress or verification code of your own.

- `webhook()` declares an endpoint that routes a verified, typed event to an `onEvent` handler. Choose a source with a preset (`webhooks.stripe()`, `webhooks.github()`, and others) or `webhooks.custom<T>(config)`. Declared webhooks are discovered like tasks and synced to a hosted URL on deploy.
- `filter` gates which deliveries run, using a type-safe expression checked against the event at author time (`event.`/`header.`/`webhook.` paths, `&&`/`||`, comparison and `in`/`contains` operators, field-to-field comparison, and array quantifiers). A non-matching delivery is still recorded, not routed.
- HTTP API for listing webhook endpoints and deliveries, plus rotate-secret, enable/disable, and replay.

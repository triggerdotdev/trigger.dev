---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Add `webhooks.hookdeck()`, a source for deliveries relayed through a Hookdeck connection. It verifies the `x-hookdeck-signature` header with the project's signing secret, keeps verifying while the secret is being rolled (Hookdeck sends the previous secret's signature in `x-hookdeck-signature-2`), and deduplicates retries on `x-hookdeck-eventid`. The event is the original provider's payload, so pass its type: `webhooks.hookdeck<Stripe.Event>()`. If the Hookdeck project's header prefix was changed, pass it as `webhooks.hookdeck({ headerPrefix })` so retries keep deduplicating.

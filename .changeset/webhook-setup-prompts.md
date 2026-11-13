---
"@trigger.dev/core": patch
---

Webhook setup prompts now match each provider's current setup. Stripe webhooks can be set up from the Dashboard by revealing the signing secret there, Discord endpoints verify on the first try because the public key is stored before the Endpoint URL is saved, and Autumn webhooks can be added self-serve without contacting support.

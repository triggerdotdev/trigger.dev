---
"@trigger.dev/core": patch
---

Correct the Stripe, Discord and Autumn webhook setup prompts. The Stripe prompt now covers revealing the signing secret in the Dashboard, the Discord prompt sets the public key before the Endpoint URL so Discord's PING verifies, and the Autumn prompt drops the outdated beta note.

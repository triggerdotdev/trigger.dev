---
"@trigger.dev/core": patch
---

Webhook verifier artifacts can now declare the provider's response contract as data: a handshake `respondStatus`, the status codes returned for accepted deliveries and rejected signatures, and a GET verification flow (`getHandshake`) for providers that confirm a callback URL with a challenge. HMAC verifiers can read the timestamp from a body field, which the Linear provider config uses for its replay window, and the dashboard's test-send re-signs a recorded sample as of now so it passes that window.

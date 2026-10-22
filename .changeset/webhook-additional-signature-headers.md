---
"@trigger.dev/core": patch
---

HMAC webhook verifier configs accept `additionalSignatureHeaders`: more headers that can carry a signature, matched as alternatives to `signatureHeader`. Providers that send a second signature during a secret rotation (Hookdeck's `x-hookdeck-signature-2`) keep verifying through the rotation.

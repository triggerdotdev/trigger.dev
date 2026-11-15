---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Fix webhook verification for `webhooks.brex()`, which now reads the `webhook-id`, `webhook-timestamp` and `webhook-signature` headers Brex sends instead of `svix-*` headers, and for `webhooks.composio()`, which now keys the signature with the secret's raw text as Composio does instead of base64-decoding it. PagerDuty, Sentry, Vercel, Zendesk, Attio, DocuSign and Intercom endpoints now default to pasting the provider-issued signing secret, and Linear and Calendly offer both generating and pasting one. Redeploy with this version for existing endpoints to pick up the change.

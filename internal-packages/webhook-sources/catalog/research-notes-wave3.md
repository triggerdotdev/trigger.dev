# Webhook provider seed research, wave 3 (auth / observability / AI-infra additions, 2026-07-14)

New providers not already in research-notes.md or wave2.

## Observability

- sentry | Sentry | observability | hmac-sha256 hex (sentry-hook-signature) | preset=null | AI:high pop:high | https://docs.sentry.io/product/integrations/integration-platform/webhooks/
- datadog | Datadog | observability | none (custom static header only, e.g. API key) | preset=null | AI:high pop:high | https://docs.datadoghq.com/integrations/webhooks/
- pagerduty | PagerDuty | observability | hmac-sha256 hex (x-pagerduty-signature v1=; v3 webhooks) | preset=null | AI:high pop:high | https://developer.pagerduty.com/docs/webhooks/webhook-signatures/

## Auth / identity

- auth0 | Auth0 | auth-identity | bearer-token (Custom Webhook log streams; static Authorization) | preset=null | AI:high pop:high | https://auth0.com/docs/customize/log-streams/custom-log-streams
- workos | WorkOS | auth-identity | hmac-sha256 (WorkOS-Signature t=,v= comma-delimited; svix-like construction) | preset=null | AI:high pop:med | https://workos.com/docs/events/data-syncing/webhooks
- okta | Okta | auth-identity | shared-secret header + one-time GET challenge (no HMAC) | preset=null | AI:high pop:high | https://developer.okta.com/docs/concepts/event-hooks/
- supabase | Supabase | hosting-infra/data | custom header shared secret (pg_net db webhooks; no built-in sig) | preset=null | AI:high pop:high | https://supabase.com/docs/guides/database/webhooks
- EXCLUDE firebase (Firestore/Auth triggers only invoke your own Cloud Functions; no outbound webhook)

## AI infra / meeting

- recall-ai | Recall.ai | ai-platform | svix (webhook-id/timestamp/signature, whsec_) | preset=svix | AI:high pop:med | https://docs.recall.ai/docs/authenticating-requests-from-recallai
- fireflies | Fireflies.ai | ai-platform | none/unknown | preset=null | AI:med pop:med | https://docs.fireflies.ai/graphql-api/webhooks

## CRM / chat additions

- close-crm | Close | crm | hmac-sha256 (close-sig-hash over ts+payload) | preset=null | AI:high pop:med | https://developer.close.com/topics/webhooks/
- telegram | Telegram Bot API | communication | shared-secret header (X-Telegram-Bot-Api-Secret-Token, string compare) | preset=null | AI:high pop:high | https://core.telegram.org/bots/api#setwebhook

## Forms addition

- jotform | Jotform | forms | none (URL secret / re-fetch by submissionID) | preset=null | AI:med pop:med | https://www.jotform.com/help/245-how-to-send-submission-data-via-a-webhook/

## svix cluster now (round-trippable against our svix preset today)

clerk, resend, openai, anthropic, replicate, brex, mercury, render, recall-ai (+ standard-webhooks-compatible: gitlab-signing-token, loops).

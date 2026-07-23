# Provider build brief (read this fully, then build your assigned provider)

You are building ONE provider for the webhook sample library. Do the work YOURSELF. Do NOT spawn or
delegate to any subagents. Only create your provider's own files; do NOT edit any shared file
(`providers.json`, any `index.ts`, `samples.ts`, or another provider's files).

PACKAGE: `/Users/eric/code/triggerdotdev/isolated/webhooks/internal-packages/webhook-sources`

## What to create

Find your provider's row in the FACTS table below. Then:

**A registry entry, always:** `src/registry/<id>.ts` exporting `entry` (see clerk reference).

**Sample bodies, depending on `source`:**
- `source=hookdeck` -> samples already exist in `src/generated/hookdeck-samples.json`. Do NOT author a
  sample file. Just read that JSON, confirm entries for your provider, and report count + eventTypes.
- `source=handauthored` -> create `src/handAuthored/<id>.ts` exporting `samples: SampleRecord[]` with
  4 to 6 representative events. USE WEB SEARCH against the docs URL to get the REAL payload shape.

## Reference (clerk)

`src/registry/clerk.ts`:
```
import { type ProviderRegistryEntry } from "./types.js";
export const entry: ProviderRegistryEntry = {
  id: "clerk", label: "Clerk", category: "auth-identity",
  docsUrl: "https://clerk.com/docs/integrations/webhooks/overview",
  preset: "svix", secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" }, sampleSource: "handauthored",
};
```
`src/handAuthored/clerk.ts` exports `export const samples: SampleRecord[] = [ { provider, providerLabel, presetId, eventType, name, description?, body, docsUrl?, provenance } ]`.

## Shapes

`ProviderRegistryEntry`: `id, label, category, icon?, docsUrl?, preset?, secretProvisioning ("provider"|"integrator"|"either"), eventTypeSource ({from:"body",path} | {from:"header",name}), sampleSource ("hookdeck"|"octokit"|"capture"|"handauthored")`.

`SampleRecord`: `provider (string), providerLabel?, presetId? (one of stripe|github|svix|square|discord), eventType (string), name (string), description?, body (the event JSON), extraHeaders? (record of NON-signature routing headers), docsUrl?, provenance ({kind:"handauthored", snapshotDate:"2026-07"})`.

## Preset verification (CRITICAL: verify before you set `preset`/`presetId`)

Your row lists a preset HYPOTHESIS. Set `entry.preset` and every sample's `presetId` to it ONLY if the
provider's real signature wire format EXACTLY matches one of ours below. If it does not match, DROP the
preset: omit `entry.preset`, omit `presetId`, keep `sampleSource`, and report that you downgraded to
sample-only and why.

- `stripe`: header `stripe-signature` = `t=<unix>,v1=<hex>`, HMAC-SHA256 over `{t}.{rawBody}`.
- `github`: header `x-hub-signature-256` = `sha256=<hex>`, HMAC-SHA256 over `rawBody`. (A provider using
  `x-hub-signature` WITHOUT the `-256`, or SHA1, does NOT match.)
- `svix` (Standard Webhooks): headers `webhook-id`/`webhook-timestamp`/`webhook-signature` (or the
  `svix-*` equivalents), HMAC-SHA256 base64 over `{id}.{timestamp}.{rawBody}`, secret `whsec_`-prefixed.
- `square`: header `x-square-hmacsha256-signature`, HMAC-SHA256 base64 over `{notificationUrl}{rawBody}`.
- `discord`: headers `X-Signature-Ed25519` + `X-Signature-Timestamp`, Ed25519 over `{timestamp}{rawBody}`.

## Rules

- `eventType` MUST equal the real discriminant value for that sample (from the row's `discriminant`).
- **Header-discriminated providers** (row says `discriminant=header:<name>`): the body has no type field,
  so add `extraHeaders: { "<name>": "<eventType>" }` to each sample so the type survives loading.
  Body-discriminated providers must NOT set signature headers in `extraHeaders` (the composer signs at
  send time; never store a signature).
- Some providers deliver an ARRAY of events (e.g. SendGrid) or a nested/wrapped shape (row notes it);
  model the body faithfully and set `eventType` to the meaningful value. Some are form-encoded (Twilio):
  represent the body as the key/value object.
- Use realistic-but-FAKE ids/values; no real secrets or PII.
- This repo BLOCKS new `//` line comments via a hook. Use `/** */` JSDoc only, or none. If a Write is
  rejected for comments, remove them and retry.
- Import paths end in `.js`. Do NOT run tests, aggregate, or typecheck; do NOT touch index files.

## Report format (final message, plain text)

`FILES: <paths>. PRESET: <set to X | downgraded to sample-only because ...>. EVENTS: <event types>. SOURCE: <docs URL verified>. CAVEATS: <anything uncertain>.`

## FACTS (one row per provider)

Columns: id | label | category | tier | preset-hypothesis | scheme | discriminant | secret | source | docsUrl | suggested events

- stripe | Stripe | payments | first-class | stripe | hmac-sha256 t=,v1= | body:type | integrator | hookdeck | https://docs.stripe.com/webhooks | (registry only; ~13 hookdeck samples already tagged presetId=stripe)
- anthropic | Anthropic (Claude) | ai-platform | first-class | svix | standard-webhooks | body:type | provider | handauthored | https://platform.claude.com/docs/en/managed-agents/webhooks | session.status_idled, session.run_started, deployment_run.succeeded, deployment_run.failed, agent.* (Managed Agents; envelope {id,type,created_at,data})
- resend | Resend | email | first-class | svix | svix | body:type | provider | handauthored | https://resend.com/docs/dashboard/webhooks/introduction | email.sent, email.delivered, email.bounced, email.complained, email.opened, email.clicked (body {type, created_at, data})
- replicate | Replicate | ai-platform | first-class | svix | standard-webhooks | body:status | provider | handauthored | https://replicate.com/docs/topics/webhooks/verify-webhook | prediction succeeded/failed/canceled (body = prediction object {id, status, output, ...}); pick eventType from status
- brex | Brex | fintech | first-class | svix | svix | body:type | provider | handauthored | https://developer.brex.com/docs/webhooks/ | card transaction/expense/budget events per docs
- recall-ai | Recall.ai | ai-platform | first-class | svix | standard-webhooks | body:event | provider | handauthored | https://docs.recall.ai/docs/authenticating-requests-from-recallai | bot.status_change, recording.done, transcript.done (body {event, data})
- square | Square | payments | first-class | square | hmac-sha256 (url+body) | body:type | integrator | handauthored | https://developer.squareup.com/docs/webhooks/step3validate | payment.created, payment.updated, order.created, refund.created (body {merchant_id, type, event_id, created_at, data})
- discord | Discord | communication | first-class | discord | ed25519 | body:type | provider | handauthored | https://docs.discord.com/developers/events/webhook-events | Webhook Events (type 0 with body.event.type e.g. APPLICATION_AUTHORIZED) and/or Interactions PING (type 1); numeric top-level type, verify carefully and note in caveats
- gitlab | GitLab | source-control | first-class | svix (VERIFY signing-token) | default plaintext X-Gitlab-Token OR opt-in signing-token | header:x-gitlab-event (also body.object_kind) | integrator | hookdeck | https://docs.gitlab.com/user/project/integrations/webhooks/ | 7 untagged hookdeck samples exist. If GitLab's signing-token is standard-webhooks-compatible, hand-author 3-4 svix-tagged samples; else register sample-only (drop preset) and rely on hookdeck samples
- whatsapp | WhatsApp (Meta) | communication | first-class | github (VERIFY x-hub-signature-256) | hmac-sha256 x-hub-signature-256 | body (entry[].changes[].value.field: messages|statuses) | integrator | handauthored | https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/ | inbound message, message status (deep nested; set eventType to the change field like "messages"/"statuses"); verify header is x-hub-signature-256 sha256=
- jira | Jira | pm | first-class | github (VERIFY: Jira uses x-hub-signature WITHOUT -256, likely NO match) | hmac-sha256 x-hub-signature | body:webhookEvent | integrator | handauthored | https://developer.atlassian.com/cloud/jira/platform/webhooks/ | jira:issue_created, jira:issue_updated, comment_created (body {webhookEvent, issue, ...}); if header is x-hub-signature (no -256) it does NOT match our github preset -> downgrade to sample-only
- twilio | Twilio | communication | sample-only | none | hmac-sha1 | body (form-encoded; no type field) | integrator | handauthored | https://www.twilio.com/docs/usage/webhooks/webhooks-security | inbound SMS and call-status; body is a key/value object of form params; set eventType like "message.inbound" / "call.status-callback"
- telegram | Telegram | communication | sample-only | none | shared-secret | body (Update object; key present = type, e.g. message/callback_query) | integrator | handauthored | https://core.telegram.org/bots/api#setwebhook | message, edited_message, callback_query, inline_query; eventType = the update field name
- zoom | Zoom | communication | sample-only | none | hmac-sha256 | body:event | integrator | handauthored | https://developers.zoom.us/docs/api/webhooks/ | meeting.started, meeting.ended, recording.completed, meeting.participant_joined (body {event, payload})
- sendgrid | SendGrid | email | sample-only | none | ecdsa | body[]:event (ARRAY of events) | provider | handauthored | https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features | delivered, open, click, bounce, spamreport; body is an ARRAY; each sample = array with one representative event, eventType = that event value
- postmark | Postmark | email | sample-only | none | basic | body:RecordType | integrator | handauthored | https://postmarkapp.com/developer/webhooks/inbound-webhook | Delivery, Bounce, SpamComplaint, Open, Inbound (body {RecordType, ...})
- zendesk | Zendesk | support | sample-only | none | hmac-sha256 | body (trigger-defined; use a common ticket shape) | integrator | handauthored | https://developer.zendesk.com/documentation/webhooks/verifying/ | ticket.created, ticket.updated (payload is configurable; use a representative ticket event JSON)
- intercom | Intercom | support | sample-only | none | hmac-sha1 | body:topic | integrator | handauthored | https://developers.intercom.com/docs/references/webhooks/webhook-models | conversation.user.created, conversation.user.replied, contact.created (body {type:"notification_event", topic, data})
- sentry | Sentry | observability | sample-only | none | hmac-sha256 | header:sentry-hook-resource (+ body.action) | integrator | handauthored | https://docs.sentry.io/product/integrations/integration-platform/webhooks/ | issue.created, issue.resolved, error.created (header sentry-hook-resource; body {action, data}); header-discriminated -> add extraHeaders
- pagerduty | PagerDuty | observability | sample-only | none | hmac-sha256 | body:event.event_type | integrator | handauthored | https://developer.pagerduty.com/docs/webhooks/webhook-signatures/ | incident.triggered, incident.acknowledged, incident.resolved (body {event:{event_type, data}})
- vercel | Vercel | hosting-infra | sample-only | none | hmac-sha1 | body:type | integrator | handauthored | https://vercel.com/docs/webhooks | deployment.created, deployment.succeeded, deployment.error, deployment.canceled (body {type, id, payload})
- linear | Linear | pm | sample-only | none | hmac-sha256 | body:type (+ body.action) | integrator | handauthored | https://linear.app/developers/webhooks | Issue create, Comment create (body {action, type, data, ...})
- auth0 | Auth0 | auth-identity | sample-only | none | bearer | body[]:data.type (log-stream events array) | integrator | handauthored | https://auth0.com/docs/customize/log-streams/custom-log-streams | successful login (s), failed login (f), signup (ss); body is an array of log events; eventType from the log event type
- workos | WorkOS | auth-identity | sample-only | none | hmac-sha256 | body:event | provider | handauthored | https://workos.com/docs/events/data-syncing/webhooks | dsync.user.created, connection.activated, user.created (body {id, event, data})
- supabase | Supabase | hosting-infra | sample-only | none | shared-secret | body:type (INSERT/UPDATE/DELETE) | integrator | handauthored | https://supabase.com/docs/guides/database/webhooks | INSERT, UPDATE, DELETE (body {type, table, schema, record, old_record})
- notion | Notion | productivity | sample-only | none | hmac-sha256 | body:type | provider | handauthored | https://developers.notion.com/reference/webhooks | page.content_updated, page.created, database.content_updated (body {type, ...}); verify current event type names via docs
- attio | Attio | crm | sample-only | none | hmac-sha256 | body:events[].event_type | integrator | handauthored | https://docs.attio.com/rest-api/guides/webhooks | record.created, record.updated, list-entry.created (body {events:[{event_type, id}], webhook_id})
- close-crm | Close | crm | sample-only | none | hmac-sha256 | body:event.action (+ object_type) | provider | handauthored | https://developer.close.com/topics/webhooks/ | lead.created, activity.created, opportunity.status_change (body {event:{action, object_type, data}})
- hubspot | HubSpot | crm | sample-only | none | hmac-sha256 v3 | body[]:subscriptionType (ARRAY) | provider | hookdeck | https://developers.hubspot.com/docs/guides/api/app-management/webhooks | (registry only; ~3 hookdeck samples exist; report them)
- calendly | Calendly | calendar-scheduling | sample-only | none | hmac-sha256 | body:event | provider | handauthored | https://developer.calendly.com/api-docs/4c305798a61d3-webhook-signatures | invitee.created, invitee.canceled (body {event, created_at, payload})
- cal-com | Cal.com | calendar-scheduling | sample-only | none | hmac-sha256 | body:triggerEvent | integrator | handauthored | https://cal.com/docs/developing/guides/automation/webhooks | BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED, MEETING_ENDED (body {triggerEvent, createdAt, payload})
- typeform | Typeform | forms | sample-only | none | hmac-sha256 | body:event_type | integrator | handauthored | https://www.typeform.com/developers/webhooks/secure-your-webhooks/ | form_response (body {event_id, event_type, form_response})
- docusign | DocuSign | e-signature | sample-only | none | hmac-sha256 | body:event | integrator | handauthored | https://developers.docusign.com/platform/webhooks/connect/ | envelope-completed, envelope-sent, recipient-completed (Connect JSON body {event, apiVersion, data})
- shopify | Shopify | commerce | sample-only | none | hmac-sha256 | header:x-shopify-topic | integrator | hookdeck | https://shopify.dev/docs/apps/build/webhooks/verify-deliveries | (registry only; ~181 hookdeck samples; header-discriminated, confirm samples carry x-shopify-topic)
- plaid | Plaid | fintech | sample-only | none | jwt es256 | body:webhook_type (+ webhook_code) | provider | handauthored | https://plaid.com/docs/api/webhooks/webhook-verification/ | TRANSACTIONS/SYNC_UPDATES_AVAILABLE, ITEM/ERROR, ITEM/LOGIN_REQUIRED (body {webhook_type, webhook_code, item_id, ...}); set eventType like "TRANSACTIONS.SYNC_UPDATES_AVAILABLE"
- elevenlabs | ElevenLabs | voice | sample-only | none | hmac-sha256 | body:type | provider | handauthored | https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks | post_call_transcription, post_call_audio, call_initiation_failure (body {type, event_timestamp, data})
- vapi | Vapi | voice | sample-only | none | hmac-sha256 | body:message.type | integrator | handauthored | https://docs.vapi.ai/server-url/server-authentication | end-of-call-report, status-update, transcript, tool-calls (body {message:{type, ...}})
- retell | Retell AI | voice | sample-only | none | hmac-sha256 | body:event | provider | handauthored | https://docs.retellai.com/features/secure-webhook | call_started, call_ended, call_analyzed (body {event, call})
- assemblyai | AssemblyAI | ai-platform | sample-only | none | shared-secret | body:status | integrator | handauthored | https://www.assemblyai.com/docs/concepts/webhooks | transcript completed, error (body {transcript_id, status})
- deepgram | Deepgram | ai-platform | sample-only | none | none-or-ip-allowlist | body (async transcript result; no type field) | integrator | handauthored | https://developers.deepgram.com/docs/callback | transcript ready (body = Deepgram results object); set eventType like "transcript.completed"

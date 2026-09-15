# Webhook provider seed research (raw notes, 2026-07-14)

Findings from the seed-research subagents. `preset` = one of our exact presets (stripe/github/svix/
square/discord) where the scheme matches exactly, else null (needs a custom config or ships sample-only).
Rank/tier finalized during the merge into providers.json.

## Voice AI / conversational voice

- elevenlabs | ElevenLabs | voice | hmac-sha256 (ElevenLabs-Signature, t=,v0=, over raw bytes; SDK constructEvent) | preset=null | AI:high pop:high | https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
- vapi | Vapi | voice | hmac-sha256 (X-Vapi-Signature when secret set; else X-Vapi-Secret static) | preset=null | AI:high pop:high | https://docs.vapi.ai/server-url/server-authentication
- retell | Retell AI | voice | hmac-sha256 (x-retell-signature v=,d=; HMAC(body+ts, api_key); 5min replay; SDK verify) | preset=null | AI:high pop:high | https://docs.retellai.com/features/secure-webhook
- bland | Bland AI | voice | hmac-sha256 (X-Webhook-Signature; per webhook-signing doc) | preset=null | AI:med pop:med | https://docs.bland.ai/tutorials/webhook-signing

## AI / ML compute / STT

- replicate | Replicate | ai-platform | svix (standard-webhooks exactly, whsec_) | preset=svix | AI:high pop:high | https://replicate.com/docs/topics/webhooks/verify-webhook
- openai | OpenAI | ai-platform | svix (standard-webhooks, whsec_, SDK unwrap) | preset=svix | AI:high pop:high | https://developers.openai.com/api/docs/guides/webhooks
- anthropic | Anthropic (Claude Managed Agents) | ai-platform | svix (X-Webhook-Signature, whsec_, unwrap; NOT for Message Batches) | preset=svix | AI:high pop:high | https://platform.claude.com/docs/en/managed-agents/webhooks
- assemblyai | AssemblyAI | ai-platform | shared-secret (caller-defined webhook_auth_header_name/value, echoed; NOT hmac) | preset=null | AI:med pop:med | https://www.assemblyai.com/docs/concepts/webhooks
- deepgram | Deepgram | ai-platform | none/callback (per-request ?callback=; dg-token or basic auth; no hmac) | preset=null | AI:med pop:med | https://developers.deepgram.com/docs/callback
- huggingface | Hugging Face | ai-platform | basic/shared-secret (X-Webhook-Secret static, or ?secret=) | preset=null | AI:med pop:med | https://huggingface.co/docs/hub/en/webhooks
- runpod | RunPod | ai-platform | none (per-request webhook field; no signing) | preset=null | AI:med pop:med | https://docs.runpod.io/serverless/endpoints/send-requests
- EXCLUDE together-ai (Batch API poll-only, no webhook)
- EXCLUDE modal (inbound web functions only, no outbound webhook)

## Communication / video

- slack | Slack | communication | hmac-sha256 (v0:{ts}:{body}, X-Slack-Signature v0=, X-Slack-Request-Timestamp, 5min replay) | preset=null | AI:high pop:high | https://docs.slack.dev/authentication/verifying-requests-from-slack/
- discord | Discord | communication | ed25519 (X-Signature-Ed25519 + X-Signature-Timestamp over ts+body; both Webhook Events + Interactions) | preset=discord | AI:high pop:high | https://docs.discord.com/developers/events/webhook-events
- microsoft-teams | Microsoft Teams (Outgoing Webhooks) | communication | hmac-sha256 (over raw body, base64 token, Authorization header; NOT the Workflows connector) | preset=null | AI:high pop:high | https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-outgoing-webhook
- zoom | Zoom | communication | hmac-sha256 (v0:{x-zm-request-timestamp}:{body}, x-zm-signature v0=; URL-validation challenge on setup) | preset=null | AI:high pop:high | https://developers.zoom.us/docs/api/webhooks/
- webex | Cisco Webex | communication | hmac-sha1 (X-Spark-Signature over raw body) | preset=null | AI:med pop:med | https://developer.webex.com/messaging/docs/api/guides/webhooks
- google-calendar | Google Calendar (push/watch) | calendar-scheduling | shared-secret (X-Goog-Channel-Token echo, no crypto sig; thin notification, re-fetch) | preset=null | AI:high pop:high | https://developers.google.com/workspace/calendar/api/guides/push
- microsoft-graph | Microsoft Graph / Outlook | communication | clientState shared-secret default + signed JWT (validationTokens) for rich notifications; setup handshake echoes validationToken | preset=null | AI:high pop:high | https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
- daily | Daily.co | communication | hmac-sha256 ({X-Webhook-Timestamp}.{body}, base64 secret, X-Webhook-Signature) | preset=null | AI:med pop:med | https://docs.daily.co/reference/rest-api/webhooks
- livekit | LiveKit | communication | jwt (Authorization JWT signed w/ api secret, carries sha256 body hash; SDK WebhookReceiver) | preset=null | AI:med pop:med | https://docs.livekit.io/home/server/webhooks/
- whereby | Whereby | communication | hmac-sha256 (Stripe-style Whereby-Signature t=,v1=; {ts}.{body}) | preset=null | AI:low pop:med | https://docs.whereby.com/meeting-content-and-quality/insights-suite-and-api/webhooks
- EXCLUDE google-meet (Workspace Events API delivers to Pub/Sub only, no HTTP webhook)

## SMS / voice / CPaaS

- twilio | Twilio | communication | hmac-sha1 (X-Twilio-Signature base64 over URL + sorted POST params, key=Auth Token) | preset=null | AI:high pop:high | https://www.twilio.com/docs/usage/webhooks/webhooks-security
- vonage | Vonage | communication | jwt HS256 (Authorization: Bearer, signature secret; optional payload_hash claim) | preset=null | AI:med pop:med | https://developer.vonage.com/en/messages/code-snippets/configure-webhooks
- telnyx | Telnyx | communication | ed25519 (telnyx-signature-ed25519 + telnyx-timestamp over ts|payload; asymmetric public key) | preset=null | AI:med pop:med | https://developers.telnyx.com/docs/voice/programmable-voice/voice-api-webhooks
- bird | Bird (MessageBird) | communication | jwt HS256 (MessageBird-Signature-JWT over URL + body sha256 + ts; legacy raw hmac-sha256) | preset=null | AI:med pop:med | https://docs.bird.com/api/notifications-api/api-reference/webhook-subscriptions/verifying-a-webhook-subscription
- whatsapp | WhatsApp / Meta (Graph) | communication | hmac-sha256 (X-Hub-Signature-256 sha256= over raw body, app secret; GET subscribe handshake) SAME SCHEME AS GITHUB | preset=github? (verify header/format) | AI:high pop:high | https://developers.facebook.com/docs/graph-api/webhooks/getting-started
- plivo | Plivo | communication | hmac-sha256 (X-Plivo-Signature-V3 over URL + sorted params + nonce, base64) | preset=null | AI:med pop:med | https://www.plivo.com/docs/voice/concepts/signature-validation
- sinch | Sinch | communication | hmac-sha256 (X-Sinch-Signature over body.nonce.timestamp) | preset=null | AI:med pop:med | https://developers.sinch.com/docs/conversation/callbacks
- bandwidth | Bandwidth | communication | basic-auth (challenge-response 401 then Basic creds; no payload sig) | preset=null | AI:med pop:med | https://dev.bandwidth.com/docs/numbers/webhooks/
- ringcentral | RingCentral | communication | shared-secret (Validation-Token echo on setup + optional static Verification Token header; no per-payload sig) | preset=null | AI:med pop:med | https://developers.ringcentral.com/guide/notifications/webhooks/creating-webhooks

## Payments / commerce / fintech

- stripe | Stripe | payments | stripe (Stripe-Signature t=,v1=, HMAC-SHA256 {ts}.{body}) | preset=stripe | AI:high pop:high | https://docs.stripe.com/webhooks/signature | (already in 19)
- stripe-issuing | Stripe Issuing | payments | stripe (identical to core Stripe; real-time auth events) | preset=stripe | AI:med pop:med | https://docs.stripe.com/issuing/controls/real-time-authorizations
- paypal | PayPal | payments | rsa-sha256 asymmetric (PAYPAL-TRANSMISSION-SIG + cert URL; verify offline or via API) | preset=null | AI:high pop:high | https://developer.paypal.com/api/rest/webhooks/rest/ | (already in 19)
- square | Square | payments/commerce | hmac-sha256 (x-square-hmacsha256-signature over notificationURL + body; URL in signed string) | preset=square | AI:high pop:high | https://developer.squareup.com/docs/webhooks/step3validate
- adyen | Adyen | payments | hmac-sha256 (signature IN PAYLOAD additionalData.hmacSignature, not header) | preset=null | AI:high pop:high | https://docs.adyen.com/development-resources/webhooks/secure-webhooks/verify-hmac-signatures | (already in 19)
- braintree | Braintree | payments | sdk form-param (bt_signature + bt_payload, hmac-sha1 based; SDK parse only) | preset=null | AI:med pop:med | https://developer.paypal.com/braintree/docs/guides/webhooks/parse/node
- checkout-com | Checkout.com | payments | hmac-sha256 (Cko-Signature over raw body, hex) | preset=null | AI:med pop:med | https://www.checkout.com/docs/developer-resources/event-notifications/receive-webhooks | (maps to existing "checkout" samples)
- authorize-net | Authorize.Net | payments | hmac-sha512 (X-ANET-Signature sha512= over JSON body) | preset=null | AI:med pop:med | https://developer.authorize.net/api/reference/features/webhooks.html
- klarna | Klarna | payments/bnpl | hmac-sha256 (Klarna-Signature over raw body + Klarna-Signing-Key-Id) | preset=null | AI:med pop:high | https://docs.klarna.com/ | CAVEAT: acquirer/route-dependent
- affirm | Affirm | payments/bnpl | hmac-sha512 (X-Affirm-Signature) | preset=null | AI:low pop:med | https://docs.affirm.com/developers/v1.1-developer-reference/docs/about-webhooks | CAVEAT: Key/Enterprise only, not self-serve

## Calendar / scheduling

- cal-com | Cal.com | calendar-scheduling | hmac-sha256 (X-Cal-Signature-256 hex over raw body) | preset=null | AI:high pop:high | https://cal.com/docs/developing/guides/automation/webhooks
- calendly | Calendly | calendar-scheduling | hmac-sha256 (Calendly-Webhook-Signature t=,v1= Stripe-style {ts}.{body}) | preset=null | AI:high pop:high | https://developer.calendly.com/api-docs/4c305798a61d3-webhook-signatures
- acuity | Acuity Scheduling | calendar-scheduling | hmac-sha256 BASE64 (X-Acuity-Signature, key=API key) | preset=null | AI:med pop:high | https://developers.acuityscheduling.com/docs/webhooks
- nylas | Nylas | calendar-scheduling | hmac-sha256 (X-Nylas-Signature hex over raw body; compressed = hmac over compressed bytes) | preset=null | AI:med pop:med | https://developer.nylas.com/docs/v3/webhooks/
- savvycal | SavvyCal | calendar-scheduling | hmac-sha256 (X-Savvycal-Signature sha256=hex) | preset=null | AI:low pop:med | https://savvycal.com/docs/api/webhooks/
- chili-piper | Chili Piper | calendar-scheduling | none documented (URL secrecy / custom headers) | preset=null | AI:med pop:med | https://help.chilipiper.com | CAVEAT: no verifiable signature
- EXCLUDE doodle (enterprise-gated, undocumented, Zapier-only path)
- EXCLUDE zoho-bookings / zoho-calendar (no native outbound webhooks; webhooks live in Zoho Flow/CRM)

## Preset-mapping notes for the merge

- svix preset: replicate, openai, anthropic (+ clerk, resend already planned).
- stripe preset: stripe, stripe-issuing.
- square preset: square.
- discord preset: discord.
- github preset: github; VERIFY whatsapp/meta (X-Hub-Signature-256 sha256= looks identical to GitHub) as a potential github-preset reuse.
- Everything else (generic hmac variants w/ own header+template, ed25519 non-discord, jwt, rsa, basic, shared-secret) = custom verifier config authored later, or ships sample-only for v1.
- Notable signature-scheme diversity to cover in the sample library: hmac-sha1 (twilio, webex, braintree-ish), hmac-sha512 (authorize-net, affirm), rsa-sha256 (paypal), ed25519 (discord, telnyx), jwt-in-authorization (livekit, vonage, bird), in-payload hmac (adyen), shared-secret/echo (google-calendar, ms-graph default, ringcentral, assemblyai, huggingface, bland-alt).

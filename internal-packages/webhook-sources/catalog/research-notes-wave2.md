# Webhook provider seed research, wave 2 (raw notes, 2026-07-14)

Same format as research-notes.md. `preset` = exact match to one of ours (stripe/github/svix/square/
discord) else null. Finalize tier/rank in the merge.

## Support / helpdesk / live-chat

- zendesk | Zendesk | support | hmac-sha256 base64 (X-Zendesk-Webhook-Signature over ts+body; X-Zendesk-Webhook-Signature-Timestamp; test secret documented) | preset=null | AI:high pop:high | https://developer.zendesk.com/documentation/webhooks/verifying/
- intercom | Intercom | support | hmac-sha1 (X-Hub-Signature sha1= over raw body, key=client secret) | preset=null | AI:high pop:high | https://developers.intercom.com/docs/references/webhooks/webhook-models
- front | Front | support | hmac-sha256 base64 (X-Front-Signature over ts+":"+body; X-Front-Request-Timestamp) | preset=null | AI:med pop:med | https://dev.frontapp.com/docs/application-webhooks
- helpscout | Help Scout | support | hmac-sha1 base64 (X-HelpScout-Signature over raw body) | preset=null | AI:med pop:med | https://developer.helpscout.com/webhooks/
- crisp | Crisp | support | hmac-sha256 (X-Crisp-Signature over "[ts;body]"; X-Crisp-Request-Timestamp) | preset=null | AI:med pop:med | https://docs.crisp.chat/references/web-hooks/v1/
- freshdesk | Freshdesk | support | none (basic auth / custom header you configure) | preset=null | AI:high pop:high | https://support.freshdesk.com/support/solutions/articles/50000009511
- freshchat | Freshchat | support | rsa-sha256 asymmetric (X-Freshchat-Signature, provider public key) | preset=null | AI:med pop:med | https://crmsupport.freshworks.com/support/solutions/articles/50000004461
- gorgias | Gorgias | support | none (custom headers / OAuth2) | preset=null | AI:med pop:med (Shopify e-comm) | https://docs.gorgias.com/http-integrations-81822
- livechat | LiveChat (Text Platform) | support | shared-secret in payload (secret_key field in body) | preset=null | AI:med pop:med | https://platform.text.com/docs/management/webhooks
- kustomer | Kustomer | support | none (custom headers) | preset=null | AI:med pop:med (enterprise) | https://developer.kustomer.com/kustomer-apps-platform/docs/outbound-webhooks
- chatwoot | Chatwoot | support | hmac-sha256 (X-Chatwoot-Signature sha256= over ts.body; caveat self-hosted secret bug) | preset=null | AI:med pop:med (self-host) | https://developers.chatwoot.com/api-reference/webhooks/add-a-webhook
- aircall | Aircall | voice/support | token-in-body (no hmac in official docs) | preset=null | AI:med pop:med | https://developer.aircall.io/tutorials/webhooks-guide/
- EXCLUDE drift (product sunsetting 2026-03; docs 404)

## Forms / e-signature / storage / CMS

- typeform | Typeform | forms | hmac-sha256 base64 (Typeform-Signature sha256=<b64> over raw body) | preset=null | AI:high pop:high | https://www.typeform.com/developers/webhooks/secure-your-webhooks/
- tally | Tally | forms | hmac-sha256 base64 (Tally-Signature; signingSecret optional) | preset=null | AI:med pop:med | https://tally.so/help/webhooks
- docusign | DocuSign (Connect) | e-signature | hmac-sha256 base64 (X-DocuSign-Signature-1..N; up to 100 keys for rotation) | preset=null | AI:high pop:high | https://developers.docusign.com/platform/webhooks/connect/validate/
- dropbox-sign | Dropbox Sign (HelloSign) | e-signature | hmac-sha256 hex (event_hash over event_time+event_type, key=API key; not body; reply "Hello API Event Received") | preset=null | AI:med pop:med | https://developers.hellosign.com/docs/events/walkthrough/
- box | Box | storage | hmac-sha256 base64 (BOX-SIGNATURE-PRIMARY/SECONDARY over body+BOX-DELIVERY-TIMESTAMP; 10min replay) | preset=null | AI:med pop:med | https://developer.box.com/guides/webhooks/v2/signatures-v2
- dropbox | Dropbox (storage) | storage | hmac-sha256 hex (X-Dropbox-Signature over raw body, app secret; GET ?challenge= verify; change-ping only) | preset=null | AI:med pop:high | https://www.dropbox.com/developers/reference/webhooks
- google-drive | Google Drive (push/watch) | storage | none (X-Goog-Channel-Token equality; empty-body pings, re-fetch; channels expire) | preset=null | AI:high pop:high | https://developers.google.com/workspace/drive/api/guides/push
- segment | Segment | data | hmac-sha1 hex (X-Signature over raw body; optional; batching signs only first event) | preset=null | AI:med pop:high | https://segment.com/docs/connections/destinations/catalog/actions-webhook/
- contentful | Contentful | cms | hmac-sha256 hex (x-contentful-signature over CANONICAL request string; x-contentful-signed-headers; x-contentful-timestamp) | preset=null | AI:med pop:med | https://www.contentful.com/developers/docs/webhooks/request-verification/
- sanity | Sanity | cms | hmac-sha256 (sanity-webhook-signature t=,v1= over ts.body; @sanity/webhook pkg) | preset=null | AI:med pop:med | https://www.sanity.io/docs/compute-and-ai/webhooks
- webflow | Webflow | cms | hmac-sha256 hex (x-webflow-signature over "{x-webflow-timestamp}:{body}"; 5min replay) | preset=null | AI:med pop:med | https://developers.webflow.com/data/reference/request-signatures

## Devtools / source control / CI / hosting / infra / observability

- github | GitHub | source-control | hmac-sha256 hex (X-Hub-Signature-256 sha256=; legacy sha1 too) | preset=github | AI:high pop:high | https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries | (in 19)
- gitlab | GitLab | source-control | default X-Gitlab-Token plaintext equality; newer webhook-signature v1,<b64> HMAC-SHA256 over message_id.ts.body (standard-webhooks) | preset=null (svix-family for signing token) | AI:high pop:high | https://docs.gitlab.com/user/project/integrations/webhooks/ | (in 19)
- bitbucket | Bitbucket | source-control | hmac-sha256 (X-Hub-Signature sha256=, recent; older unsigned) | preset=null (github-like) | AI:med pop:med | https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/ | (in 19)
- circleci | CircleCI | ci-cd | hmac-sha256 hex (circleci-signature v1=) | preset=null | AI:med pop:med | https://circleci.com/docs/guides/integration/outbound-webhooks/
- buildkite | Buildkite | ci-cd | hmac-sha256 (X-Buildkite-Signature timestamp=,signature= over ts.body; or X-Buildkite-Token plaintext) | preset=null | AI:med pop:med | https://buildkite.com/docs/apis/webhooks/pipelines
- vercel | Vercel | hosting-infra | hmac-sha1 hex (x-vercel-signature over raw body; account webhooks Pro/Ent) | preset=null | AI:med pop:high | https://vercel.com/docs/webhooks
- netlify | Netlify | hosting-infra | jws/jwt HS256 (X-Webhook-Signature JWT carries sha256 body-hash claim) | preset=null | AI:med pop:med | https://docs.netlify.com/site-deploys/notifications/
- cloudflare | Cloudflare (Notifications) | hosting-infra | shared-secret (cf-webhook-auth plaintext; no body sig) | preset=null | AI:med pop:high | https://developers.cloudflare.com/notifications/get-started/configure-webhooks/
- render | Render | hosting-infra | svix/standard-webhooks (webhook-id/timestamp/signature over id.ts.body) | preset=svix | AI:med pop:med | https://render.com/docs/webhooks
- aws-sns | AWS SNS (HTTP subscription) | hosting-infra | rsa asymmetric (Signature+SigningCertURL in body; v2=SHA256; SubscriptionConfirmation handshake) | preset=null | AI:med pop:high | https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
- snyk | Snyk | observability/security | hmac-sha256 hex (X-Hub-Signature sha256=) | preset=null (github-like) | AI:med pop:med | https://docs.snyk.io/snyk-api/using-specific-snyk-apis/webhooks-apis/about-webhooks
- EXCLUDE fly-io (not self-serve; extension/partner only) unless we want it flagged

## CRM / PM / productivity

- linear | Linear | productivity/pm | hmac-sha256 hex (Linear-Signature over raw body; webhookTimestamp in body ~1min replay; Linear-Delivery) | preset=null | AI:high pop:high | https://linear.app/developers/webhooks
- jira | Jira (Atlassian Cloud) | pm | classic X-Hub-Signature HMAC (secret optional); dynamic webhooks JWT/bearer | preset=null (github-like for classic) | AI:med pop:high | https://developer.atlassian.com/cloud/jira/platform/webhooks/
- notion | Notion | productivity | hmac-sha256 (X-Notion-Signature over raw body, verification_token from one-time setup; SDK verifyWebhookSignature) | preset=null | AI:high pop:high | https://developers.notion.com/reference/webhooks
- airtable | Airtable | productivity | hmac-sha256 (X-Airtable-Content-MAC hmac-sha256=; PING/POLL, then fetch payloads) | preset=null | AI:high pop:high | https://airtable.com/developers/web/api/webhooks-overview
- hubspot | HubSpot | crm | v3 HMAC-SHA256 base64 (X-HubSpot-Signature-v3 over method+uri+body+ts; v1/v2 are plain sha256(secret+body)) | preset=null | AI:high pop:high | https://developers.hubspot.com/docs/guides/api/app-management/webhooks | (in 19)
- salesforce | Salesforce | crm | none (Outbound Messages SOAP unsigned; or Event Relay to EventBridge) | preset=null | AI:high pop:high | https://developer.salesforce.com/docs/atlas.en-us.api.meta/api/sforce_api_om_outboundmessaging_understanding.htm | CAVEAT: SOAP/unsigned or EventBridge-only, odd fit
- pipedrive | Pipedrive | crm | none (HTTP Basic Auth http_auth_user/password) | preset=null | AI:med pop:med | https://developers.pipedrive.com/docs/api/v1/Webhooks | (in 19)
- attio | Attio | crm | hmac-sha256 hex (Attio-Signature over raw body) | preset=null | AI:high pop:med | https://docs.attio.com/rest-api/guides/webhooks
- asana | Asana | pm | hmac-sha256 (X-Hook-Signature; X-Hook-Secret handshake echo; compact payloads, then fetch) | preset=null | AI:med pop:high | https://developers.asana.com/docs/webhooks-guide
- trello | Trello | pm | hmac-sha1 base64 (X-Trello-Webhook over body+callbackURL, key=OAuth secret) | preset=null | AI:med pop:high | https://developer.atlassian.com/cloud/trello/guides/rest-api/webhooks/
- pandadoc | PandaDoc | e-signature | hmac-sha256 hex (signature in ?signature= QUERY PARAM, not header) | preset=null | AI:med pop:med | https://developers.pandadoc.com/docs/webhook-verification

## Billing / subscriptions / commerce

- paddlebilling | Paddle Billing | billing | hmac-sha256 hex (Paddle-Signature ts=,h1= over ts:body) | preset=null | AI:high pop:high | https://developer.paddle.com/webhooks/signature-verification | (in 19)
- paddleclassic | Paddle Classic | billing | rsa public-key (p_signature in form body, DKIM-style) | preset=null | AI:low pop:med (legacy) | https://developer.paddle.com/classic/reference/ZG9jOjI1MzUzOTg2-verifying-webhooks | (in 19)
- lemonsqueezy | Lemon Squeezy | billing | hmac-sha256 hex (X-Signature over raw body) | preset=null | AI:med pop:high | https://docs.lemonsqueezy.com/help/webhooks/signing-requests
- chargebee | Chargebee | billing | none (basic auth / URL secret) | preset=null | AI:med pop:high | https://www.chargebee.com/docs/2.0/webhook_settings.html
- recurly | Recurly | billing | hmac-sha256 (recurly-signature ts,sig; older XML unsigned) | preset=null | AI:med pop:med | https://recurly.com/developers/reference/webhooks/
- revenuecat | RevenueCat | billing | static Authorization header default; optional hmac-sha256 (X-RevenueCat-Webhook-Signature t=,v1= over ts.body) | preset=null | AI:high pop:high (mobile subs) | https://www.revenuecat.com/docs/integrations/webhooks
- shopify | Shopify | commerce | hmac-sha256 base64 (X-Shopify-Hmac-Sha256 over raw body, key=app secret) | preset=null | AI:high pop:high | https://shopify.dev/docs/apps/build/webhooks/verify-deliveries | (in 19)
- bigcommerce | BigCommerce | commerce | none (custom headers you set; payload hash field; no official HMAC) | preset=null | AI:med pop:med | https://developer.bigcommerce.com/docs/integrations/webhooks/https | (in 19)
- woocommerce | WooCommerce | commerce | hmac-sha256 base64 (X-WC-Webhook-Signature over raw body) | preset=null | AI:med pop:high | https://woocommerce.github.io/woocommerce-rest-api-docs/#webhooks | (in 19)
- wix | Wix | commerce | jwt rsa (event data delivered as signed JWT; verify w/ app public key) | preset=null | AI:med pop:med | https://dev.wix.com/docs/build-apps/develop-your-app/access/authentication/verify-requests-received-from-wix
- commercelayer | Commerce Layer | commerce | hmac-sha256 (x-commercelayer-signature over raw body) | preset=null | AI:low pop:low-med | https://docs.commercelayer.io/core/callbacks-security | (in 19)
- fastspring | FastSpring | billing | hmac-sha256 base64 (X-FS-Signature; optional) | preset=null | AI:med pop:med | https://developer.fastspring.com/docs/message-security
- gumroad | Gumroad | commerce | none (form-urlencoded ping, seller_id check, URL secrecy) | preset=null | AI:low pop:med | https://gumroad.com/ping

## Email / marketing

- resend | Resend | email | svix (svix-id/timestamp/signature; SDK webhooks.verify) | preset=svix | AI:high pop:high | https://resend.com/docs/dashboard/webhooks/introduction
- sendgrid | SendGrid | email | ecdsa asymmetric (X-Twilio-Email-Event-Webhook-Signature + -Timestamp; EC public key) | preset=null | AI:high pop:high | https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
- postmark | Postmark | email | none (basic auth / IP allowlist; no HMAC) | preset=null | AI:high pop:high | https://postmarkapp.com/developer/webhooks/webhooks-overview
- mailgun | Mailgun | email | hmac-sha256 hex (signature object IN BODY: timestamp+token; not header) | preset=null | AI:high pop:high | https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks
- loops | Loops | email | hmac-sha256 (Webhook-Id/Timestamp/Signature over id.ts.body = standard-webhooks; svix-compatible) | preset=svix? (standard-webhooks) | AI:med pop:med | https://loops.so/docs/webhooks
- customerio | Customer.io | email/marketing | hmac-sha256 hex (X-CIO-Signature over "v0:{ts}:{body}"; X-CIO-Timestamp) | preset=null | AI:high pop:high | https://docs.customer.io/integrations/api/webhooks/
- mailchimp | Mailchimp (Marketing) | marketing | none (URL secret only; x-www-form-urlencoded) | preset=null | AI:med pop:high | https://mailchimp.com/developer/marketing/guides/sync-audience-data-webhooks/
- mandrill | Mandrill (MC Transactional) | email | hmac-sha1 base64 (X-Mandrill-Signature over URL+sorted params) | preset=null | AI:med pop:med | https://mailchimp.com/developer/transactional/guides/track-respond-activity-webhooks/
- klaviyo | Klaviyo | marketing | hmac-sha256 (Klaviyo-Signature + Klaviyo-Timestamp; batched) | preset=null | AI:high pop:high (ecomm) | https://developers.klaviyo.com/en/docs/working_with_system_webhooks
- braze | Braze (Currents Custom HTTP) | marketing | none (optional bearer token; Currents-gated) | preset=null | AI:med pop:med | https://www.braze.com/docs/user_guide/data/distribution/braze_currents/setting_up_currents/custom_http_connector

## Fintech / banking / crypto

- plaid | Plaid | fintech | jwt es256 asymmetric (Plaid-Verification JWT; JWK via /webhook_verification_key/get; body sha256 claim; 5min) | preset=null | AI:high pop:high | https://plaid.com/docs/api/webhooks/webhook-verification/
- coinbase-commerce | Coinbase Commerce | fintech/crypto | hmac-sha256 (X-CC-Webhook-Signature over raw body) | preset=null | AI:med pop:med | https://docs.cdp.coinbase.com/commerce/api-arcitecture/webhooks-security
- gocardless | GoCardless | fintech | hmac-sha256 (Webhook-Signature over raw body) | preset=null | AI:med pop:med | https://developer.gocardless.com/getting-started/stay-up-to-date-with-webhooks-v2/
- dwolla | Dwolla | fintech | hmac-sha256 (X-Request-Signature-SHA-256 over raw body) | preset=null | AI:med pop:med | https://developers.dwolla.com/docs/balance/webhooks/process-validate
- ramp | Ramp | fintech | hmac-sha256 (X-Ramp-Signature over raw body) | preset=null | AI:high pop:high | https://docs.ramp.com/developer-api/v1/webhooks
- brex | Brex | fintech | svix (svix-id/timestamp/signature, whsec_) | preset=svix | AI:med pop:med-high | https://developer.brex.com/docs/webhooks/
- mercury | Mercury | fintech | svix-style (whsec_, hmac-sha256; header name unconfirmed) | preset=svix? | AI:med pop:med-high | https://docs.mercury.com/reference/webhooks
- mollie | Mollie | fintech | classic=none (re-fetch); next-gen X-Mollie-Signature sha256= hmac-sha256 | preset=null | AI:med pop:high | https://docs.mollie.com/reference/webhooks-new
- razorpay | Razorpay | fintech | hmac-sha256 hex (X-Razorpay-Signature; x-razorpay-event-id for dedup) | preset=null | AI:high pop:high | https://razorpay.com/docs/webhooks/validate-test/
- wise | Wise | fintech | rsa asymmetric (X-Signature-SHA256 base64; Wise public key) | preset=null | AI:med pop:med-high | https://docs.wise.com/api-docs/features/webhooks-notifications/event-handling
- bitpay | BitPay | fintech/crypto | none by default (re-fetch invoice via API) | preset=null | AI:low pop:med | https://developer.bitpay.com/docs/invoice-webhooks
- modern-treasury | Modern Treasury | fintech | hmac-sha256 hex (X-Signature over raw body) | preset=null | AI:med pop:med | https://docs.moderntreasury.com/docs/verifying-webhooks

## Wave 2 preset/cluster notes

- svix preset cluster grows: resend, brex, mercury (+ replicate/openai/anthropic/clerk from wave 1). standard-webhooks-compatible (same wire format, verify as svix): loops, render, gitlab-signing-token.
- github preset (X-Hub-Signature-256 sha256= HMAC over raw body): github, whatsapp/meta. Close cousins on X-Hub-Signature (no -256): bitbucket (sha256), snyk (sha256), intercom (sha1), jira-classic. Worth a "github/x-hub" verifier family.
- Distinct schemes needing custom configs: ecdsa (sendgrid), es256-jwt (plaid), rsa (paypal, wise, aws-sns, freshchat, paddle-classic, wix), in-body hmac (adyen, mailgun), canonical-request (contentful), url+params hmac (mandrill, trello), query-param sig (pandadoc), ping/poll (airtable, dropbox, google-drive, asana).
- No-signature (sample-only, ship as picker samples but no round-trip): freshdesk, gorgias, livechat, kustomer, aircall, google-drive, mailchimp-marketing, postmark, chargebee, bigcommerce, gumroad, pipedrive, salesforce, cloudflare, revenuecat-default, bitpay, mollie-classic, braze.

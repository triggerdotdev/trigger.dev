import { type ProviderRegistryEntry } from "./types.js";

/**
 * Postmark does not support HMAC webhook signatures (confirmed on the webhooks overview page). Requests
 * are secured with HTTP Basic Auth embedded in the webhook URL (`https://<user>:<pass>@example.com/hook`)
 * and/or IP allowlisting, so no verifier preset applies and this ships sample-only. The Delivery/Bounce/
 * SpamComplaint/Open event webhooks carry a `RecordType` field; the separate Inbound webhook (a distinct,
 * older feature) does not - see the handAuthored file for how that sample is handled.
 */
export const entry: ProviderRegistryEntry = {
  id: "postmark",
  label: "Postmark",
  category: "email",
  docsUrl: "https://postmarkapp.com/developer/webhooks/inbound-webhook",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "RecordType" },
  sampleSource: "handauthored",
};

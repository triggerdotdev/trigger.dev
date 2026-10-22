import { type SampleRecord } from "../sampleRecord.js";

/**
 * Hookdeck samples. Hookdeck forwards the original provider's body unchanged and adds its own
 * headers, so each sample is an upstream payload plus informational `x-hookdeck-*` headers. The
 * signature headers are added by the composer at send time. `x-hookdeck-eventid` is left out: it is
 * the dedupe key, so a fixed value would fold every console send of a sample into one delivery.
 */
export const samples: SampleRecord[] = [
  {
    provider: "hookdeck",
    providerLabel: "Hookdeck",
    eventType: "payment_intent.succeeded",
    name: "Stripe payment relayed",
    description: "A Stripe `payment_intent.succeeded` event forwarded by a Hookdeck connection.",
    body: {
      id: "evt_3QhRb2LkdIwHu7ix0Wq1X9aB",
      object: "event",
      type: "payment_intent.succeeded",
      created: 1792569600,
      livemode: false,
      data: {
        object: {
          id: "pi_3QhRb2LkdIwHu7ix0kT2mN4p",
          object: "payment_intent",
          amount: 4900,
          currency: "usd",
          customer: "cus_R8xQ2mLkd91Hu7",
          status: "succeeded",
        },
      },
    },
    extraHeaders: {
      "x-hookdeck-source-name": "stripe-production",
      "x-hookdeck-attempt-count": "1",
      "x-hookdeck-attempt-trigger": "INITIAL",
    },
    docsUrl: "https://hookdeck.com/docs/destinations",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "hookdeck",
    providerLabel: "Hookdeck",
    eventType: "order.created",
    name: "Order created relayed",
    description:
      "A custom app's `order.created` event forwarded by a Hookdeck connection, on a manual retry.",
    body: {
      type: "order.created",
      id: "ord_7Kp2Qw9Lm3",
      created_at: "2026-10-21T09:00:00.000Z",
      data: {
        total: 129.5,
        currency: "EUR",
        customer: { id: "cust_48Fh2", email: "ada@example.com" },
        items: [{ sku: "TEE-BLK-M", quantity: 2 }],
      },
    },
    extraHeaders: {
      "x-hookdeck-source-name": "shop-orders",
      "x-hookdeck-attempt-count": "2",
      "x-hookdeck-attempt-trigger": "MANUAL",
    },
    docsUrl: "https://hookdeck.com/docs/destinations",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];

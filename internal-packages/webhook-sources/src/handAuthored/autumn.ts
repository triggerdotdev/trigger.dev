import { type SampleRecord } from "../sampleRecord.js";

/**
 * Autumn samples. Autumn delivers webhooks through Svix (`svix-id`/`svix-timestamp`/`svix-signature`,
 * `whsec_` secret), so `presetId: "svix"` keeps them under the round-trip guarantee. Every body has a
 * top-level `type` and a `data` object; the auto top-up events also carry a top-level `id` and
 * `occurred_at` (epoch milliseconds). Timestamps inside `subscription` snapshots are epoch milliseconds,
 * and `entity_id` appears only on entity-scoped events.
 */
export const samples: SampleRecord[] = [
  {
    provider: "autumn",
    providerLabel: "Autumn",
    presetId: "svix",
    eventType: "billing.updated",
    name: "Billing updated",
    description:
      "A customer upgraded from free to pro: the pro plan was activated and the free plan expired.",
    body: {
      type: "billing.updated",
      data: {
        object: "billing.updated",
        customer_id: "cus_acme_4821",
        plan_changes: [
          {
            action: "activated",
            subscription: {
              plan_id: "pro",
              status: "active",
              past_due: false,
              started_at: 1791936000000,
              canceled_at: null,
              expires_at: null,
              trial_ends_at: null,
              current_period_start: 1791936000000,
              current_period_end: 1794614400000,
            },
            previous_attributes: null,
            item_changes: [],
          },
          {
            action: "expired",
            subscription: {
              plan_id: "free",
              status: "expired",
              past_due: false,
              started_at: 1786060800000,
              canceled_at: 1791936000000,
              expires_at: 1791936000000,
              trial_ends_at: null,
              current_period_start: null,
              current_period_end: null,
            },
            previous_attributes: { status: "active" },
            item_changes: [],
          },
        ],
        tags: [],
      },
    },
    docsUrl: "https://docs.useautumn.com/documentation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "autumn",
    providerLabel: "Autumn",
    presetId: "svix",
    eventType: "balances.limit_reached",
    name: "Usage limit reached",
    description: "An entity under a customer hit the max purchase cap for a metered feature.",
    body: {
      type: "balances.limit_reached",
      data: {
        customer_id: "cus_acme_4821",
        feature_id: "api_calls",
        entity_id: "team_design",
        limit_type: "max_purchase",
      },
    },
    docsUrl: "https://docs.useautumn.com/documentation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "autumn",
    providerLabel: "Autumn",
    presetId: "svix",
    eventType: "balances.usage_alert_triggered",
    name: "Usage alert triggered",
    description: "A customer crossed a configured 80% usage alert for a feature.",
    body: {
      type: "balances.usage_alert_triggered",
      data: {
        customer_id: "cus_northwind_0937",
        feature_id: "credits",
        usage_alert: {
          name: "80% usage warning",
          threshold: 80,
          threshold_type: "usage_percentage",
        },
      },
    },
    docsUrl: "https://docs.useautumn.com/documentation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "autumn",
    providerLabel: "Autumn",
    presetId: "svix",
    eventType: "billing.auto_topup_succeeded",
    name: "Auto top-up succeeded",
    description: "An auto top-up charged the customer and granted more prepaid credits.",
    body: {
      type: "billing.auto_topup_succeeded",
      id: "evt_auto_topup_7kq2m9x4",
      occurred_at: 1791975423000,
      data: {
        customer_id: "cus_northwind_0937",
        feature_id: "credits",
        quantity_granted: 5000,
        threshold: 1000,
        balance_after: 5820,
        invoice_mode: false,
        invoice: {
          stripe_id: "in_1QzR8tExampleA7c2",
          status: "paid",
          total: 2500,
          currency: "usd",
          hosted_invoice_url: "https://invoice.stripe.com/i/acct_1Example/test_YWNjdF8xRXhhbXBsZQ",
        },
      },
    },
    docsUrl: "https://docs.useautumn.com/documentation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "autumn",
    providerLabel: "Autumn",
    presetId: "svix",
    eventType: "billing.auto_topup_failed",
    name: "Auto top-up failed",
    description: "An auto top-up charge was declined, so no credits were granted.",
    body: {
      type: "billing.auto_topup_failed",
      id: "evt_auto_topup_failed_3vn8w1p6",
      occurred_at: 1791998712000,
      data: {
        customer_id: "cus_globex_2214",
        feature_id: "credits",
        reason: "charge_failed",
        quantity: 5000,
        threshold: 1000,
        balance: 340,
        invoice_mode: false,
        error: {
          code: "card_declined",
          message: "Your card was declined.",
          type: "card_error",
          decline_code: "insufficient_funds",
        },
      },
    },
    docsUrl: "https://docs.useautumn.com/documentation/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];

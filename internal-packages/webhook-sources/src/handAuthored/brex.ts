import { type SampleRecord } from "../sampleRecord.js";

/**
 * Brex samples. Confirmed shapes: `TRANSFER_PROCESSED`/`TRANSFER_FAILED` (docs' own verified test
 * fixture: `event_type`, `transfer_id`, `company_id`) and `EXPENSE_PAYMENT_UPDATED` (docs' webhook
 * examples page, a card-charge event: `event_type`, `expense_id`, `payment_status`, `payment_type`,
 * `company_id`, `amount`, `payment_description`). `REFERRAL_ACTIVATED` and `USER_UPDATED` are listed
 * in the docs' webhook event catalog table but shown there without a sample payload, so their bodies
 * extrapolate the same minimal `event_type` + resource id + `company_id` shape the confirmed events
 * use.
 */
export const samples: SampleRecord[] = [
  {
    provider: "brex",
    providerLabel: "Brex",
    presetId: "svix",
    eventType: "TRANSFER_PROCESSED",
    name: "Transfer processed",
    description: "A transfer was successfully received.",
    body: {
      event_type: "TRANSFER_PROCESSED",
      transfer_id: "dptx_ck9g2h4nq000101ms2s5cz3rq",
      company_id: "cuacc_ck9wodfq7h000801q48qqsae5k",
    },
    docsUrl: "https://developer.brex.com/docs/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "brex",
    providerLabel: "Brex",
    presetId: "svix",
    eventType: "TRANSFER_FAILED",
    name: "Transfer failed",
    description: "A transfer attempt failed.",
    body: {
      event_type: "TRANSFER_FAILED",
      transfer_id: "dptx_ck3h9k2mp000201nt3t6da4sw",
      company_id: "cuacc_ck9wodfq7h000801q48qqsae5k",
    },
    docsUrl: "https://developer.brex.com/docs/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "brex",
    providerLabel: "Brex",
    presetId: "svix",
    eventType: "EXPENSE_PAYMENT_UPDATED",
    name: "Card expense payment updated",
    description: "A charge on a Brex card produced a new or updated expense payment.",
    body: {
      event_type: "EXPENSE_PAYMENT_UPDATED",
      expense_id: "expense_cl3khzfnr00000k92bdjtmmes",
      payment_status: "CLEARED",
      payment_type: "PURCHASE",
      company_id: "cuacc_ck9wodfq7h000801q48qqsae5k",
      amount: {
        amount: 4899,
        currency: "USD",
      },
      payment_description: "Acme Cloud Hosting",
    },
    docsUrl: "https://developer.brex.com/docs/webhook_examples/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "brex",
    providerLabel: "Brex",
    presetId: "svix",
    eventType: "REFERRAL_ACTIVATED",
    name: "Referral activated",
    description: "A referred contact signed up for Brex using a referral link.",
    body: {
      event_type: "REFERRAL_ACTIVATED",
      referral_id: "referral_ck7m3n9pq000401vb8x2ez6ta",
      company_id: "cuacc_ck9wodfq7h000801q48qqsae5k",
    },
    docsUrl: "https://developer.brex.com/docs/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "brex",
    providerLabel: "Brex",
    presetId: "svix",
    eventType: "USER_UPDATED",
    name: "User updated",
    description: "A user on the account was updated.",
    body: {
      event_type: "USER_UPDATED",
      user_id: "buser_ck2p6r4st000501wc9y3fa7ub",
      company_id: "cuacc_ck9wodfq7h000801q48qqsae5k",
    },
    docsUrl: "https://developer.brex.com/docs/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];

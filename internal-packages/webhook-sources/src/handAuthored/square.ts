import { type SampleRecord } from "../sampleRecord.js";

/**
 * Square samples. Square signs webhooks with an HMAC-SHA-256 signature over the notification URL
 * concatenated with the raw body, base64-encoded, in the `x-square-hmacsha256-signature` header -
 * this matches our `square` preset exactly, so `presetId: "square"` keeps them under the round-trip
 * guarantee.
 */
export const samples: SampleRecord[] = [
  {
    provider: "square",
    providerLabel: "Square",
    presetId: "square",
    eventType: "payment.created",
    name: "Payment created",
    description: "A new payment was created, in an APPROVED (not yet captured) state.",
    body: {
      merchant_id: "6SSW7HV8K2ST5",
      type: "payment.created",
      event_id: "13b867cf-db3d-4b1c-90b6-2f32a9d78124",
      created_at: "2026-07-01T21:27:30.792Z",
      data: {
        type: "payment",
        id: "hYy9pRFVxpDsO1FB05SunFWUe9JZY",
        object: {
          payment: {
            id: "hYy9pRFVxpDsO1FB05SunFWUe9JZY",
            created_at: "2026-07-01T21:16:51.086Z",
            updated_at: "2026-07-01T21:16:51.198Z",
            amount_money: { amount: 100, currency: "USD" },
            status: "APPROVED",
            delay_duration: "PT168H",
            source_type: "CARD",
            card_details: {
              status: "AUTHORIZED",
              card: {
                card_brand: "MASTERCARD",
                last_4: "9029",
                exp_month: 11,
                exp_year: 2028,
                fingerprint:
                  "sq-1-Tvruf3vPQxlvI6n0IcKYfBukrcv6IqWr8UyBdViWXU2yzGn5VMJvrsHMKpINMhPmVg",
                card_type: "CREDIT",
                prepaid_type: "NOT_PREPAID",
                bin: "540988",
              },
              entry_method: "KEYED",
              cvv_status: "CVV_ACCEPTED",
              avs_status: "AVS_ACCEPTED",
              statement_description: "SQ *DEFAULT TEST ACCOUNT",
              card_payment_timeline: { authorized_at: "2026-07-01T21:16:51.198Z" },
            },
            location_id: "S8GWD5R9QB376",
            order_id: "03O3USaPaAaFnI6kkwB1JxGgBsUZY",
            risk_evaluation: {
              created_at: "2026-07-01T21:16:51.198Z",
              risk_level: "NORMAL",
            },
            total_money: { amount: 100, currency: "USD" },
            approved_money: { amount: 100, currency: "USD" },
            capabilities: ["EDIT_TIP_AMOUNT", "EDIT_TIP_AMOUNT_UP", "EDIT_TIP_AMOUNT_DOWN"],
            receipt_number: "hYy9",
            delay_action: "CANCEL",
            delayed_until: "2026-07-08T21:16:51.086Z",
            version_token: "FfQhQJf9r3VSQIgyWBk1oqhIwiznLwVwJbVVA0bdyEv6o",
          },
        },
      },
    },
    docsUrl:
      "https://developer.squareup.com/reference/square/payments-api/webhooks/payment.created",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "square",
    providerLabel: "Square",
    presetId: "square",
    eventType: "payment.updated",
    name: "Payment updated",
    description: "A payment transitioned to COMPLETED after capture.",
    body: {
      merchant_id: "6SSW7HV8K2ST5",
      type: "payment.updated",
      event_id: "6a8f5f28-54a1-4eb0-a98a-3111513fd4fc",
      created_at: "2026-07-01T21:27:34.308Z",
      data: {
        type: "payment",
        id: "hYy9pRFVxpDsO1FB05SunFWUe9JZY",
        object: {
          payment: {
            id: "hYy9pRFVxpDsO1FB05SunFWUe9JZY",
            created_at: "2026-07-01T21:16:51.086Z",
            updated_at: "2026-07-01T21:19:00.831Z",
            amount_money: { amount: 100, currency: "USD" },
            status: "COMPLETED",
            delay_duration: "PT168H",
            source_type: "CARD",
            card_details: {
              status: "CAPTURED",
              card: {
                card_brand: "MASTERCARD",
                last_4: "9029",
                exp_month: 11,
                exp_year: 2028,
                fingerprint:
                  "sq-1-Tvruf3vPQxlvI6n0IcKYfBukrcv6IqWr8UyBdViWXU2yzGn5VMJvrsHMKpINMhPmVg",
                card_type: "CREDIT",
                prepaid_type: "NOT_PREPAID",
                bin: "540988",
              },
              entry_method: "KEYED",
              cvv_status: "CVV_ACCEPTED",
              avs_status: "AVS_ACCEPTED",
              statement_description: "SQ *DEFAULT TEST ACCOUNT",
              card_payment_timeline: {
                authorized_at: "2026-07-01T21:16:51.198Z",
                captured_at: "2026-07-01T21:19:00.832Z",
              },
            },
            location_id: "S8GWD5R9QB376",
            order_id: "03O3USaPaAaFnI6kkwB1JxGgBsUZY",
            risk_evaluation: {
              created_at: "2026-07-01T21:16:51.198Z",
              risk_level: "NORMAL",
            },
            total_money: { amount: 100, currency: "USD" },
            approved_money: { amount: 100, currency: "USD" },
            receipt_number: "hYy9",
            receipt_url: "https://squareup.com/receipt/preview/hYy9pRFVxpDsO1FB05SunFWUe9JZY",
            delay_action: "CANCEL",
            delayed_until: "2026-07-08T21:16:51.086Z",
            version_token: "bhC3b8qKJvNDdxqKzXaeDsAjS1oMFuAKxGgT32HbE6S6o",
          },
        },
      },
    },
    docsUrl:
      "https://developer.squareup.com/reference/square/payments-api/webhooks/payment.updated",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "square",
    providerLabel: "Square",
    presetId: "square",
    eventType: "order.created",
    name: "Order created",
    description: "A new order was created via the Orders API.",
    body: {
      merchant_id: "5S9MXCS9Y99KK",
      type: "order.created",
      event_id: "116038d3-2948-439f-8679-fc86dbf80f69",
      created_at: "2026-07-01T23:14:26.129Z",
      data: {
        type: "order_created",
        id: "eA3vssLHKJrv9H0IdJCM3gNqfdcZY",
        object: {
          order_created: {
            created_at: "2026-07-01T23:14:26.129Z",
            location_id: "FPYCBCHYMXFK1",
            order_id: "eA3vssLHKJrv9H0IdJCM3gNqfdcZY",
            state: "OPEN",
            version: 1,
          },
        },
      },
    },
    docsUrl: "https://developer.squareup.com/reference/square/orders-api/webhooks/order.created",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "square",
    providerLabel: "Square",
    presetId: "square",
    eventType: "refund.created",
    name: "Refund created",
    description: "A refund was created against a prior payment and is pending settlement.",
    body: {
      merchant_id: "6SSW7HV8K2ST5",
      type: "refund.created",
      event_id: "bc316346-6691-4243-88ed-6d651a0d0c47",
      created_at: "2026-07-01T21:27:41.852Z",
      data: {
        type: "refund",
        id: "KkAkhdMsgzn59SM8A89WgKwekxLZY_ptNBVqHYxt5gAdfcobBe4u1AZsXhoz06KTtuq9Ls24P",
        object: {
          refund: {
            id: "KkAkhdMsgzn59SM8A89WgKwekxLZY_ptNBVqHYxt5gAdfcobBe4u1AZsXhoz06KTtuq9Ls24P",
            created_at: "2026-07-01T21:27:41.836Z",
            updated_at: "2026-07-01T21:27:41.846Z",
            amount_money: { amount: 1000, currency: "USD" },
            status: "PENDING",
            location_id: "NAQ1FHV6ZJ8YV",
            order_id: "haOyDuHiqtAXMk0d8pDKXpL7Jg4F",
            payment_id: "KkAkhdMsgzn59SM8A89WgKwekxLZY",
            version: 7,
          },
        },
      },
    },
    docsUrl: "https://developer.squareup.com/reference/square/refunds-api/webhooks/refund.created",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];

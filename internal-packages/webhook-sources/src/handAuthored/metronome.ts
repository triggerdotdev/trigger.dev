import { type SampleRecord } from "../sampleRecord.js";

/**
 * Metronome samples. Metronome signs with a custom `Metronome-Webhook-Signature` scheme over the
 * `X-Metronome-Date` header and the body (not one of our presets), so no `presetId` is set. Every
 * payload has a top-level `id` and `type`, but the rest comes in two shapes: threshold alerts, invoice,
 * payment gate and integration notifications nest their fields under `properties`, while system
 * notifications (contract, commit, credit, subscription) put `timestamp`, `environment_type`, the object
 * ids and their custom fields at the top level.
 */
export const samples: SampleRecord[] = [
  {
    provider: "metronome",
    providerLabel: "Metronome",
    eventType: "alerts.low_remaining_credit_balance_reached",
    name: "Low credit balance reached",
    description: "A customer's remaining credit balance dropped below a configured threshold.",
    body: {
      id: "6f1d2a4b-8c3e-4f7a-9b2d-5e8c1a7f3d90",
      properties: {
        customer_id: "c2a8e4f1-7b3d-4e9a-8c6f-1d5b9e3a7c24",
        alert_id: "a4e7c1d9-3f8b-4a2e-9d6c-7b1f5e8a3c62",
        timestamp: "2026-10-14T16:20:12.418Z",
        threshold: 20000,
        alert_name: "Credit balance low",
        credit_type_id: "2714e483-4ff1-48e4-9e25-ac732e8f24f2",
        remaining_balance: 4850,
        triggered_by: "usage",
      },
      type: "alerts.low_remaining_credit_balance_reached",
    },
    docsUrl: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "metronome",
    providerLabel: "Metronome",
    eventType: "alerts.spend_threshold_reached",
    name: "Spend threshold reached",
    description: "A customer's spend crossed a configured spend threshold.",
    body: {
      id: "9b3e7d1c-2a5f-4c8e-b6d4-3f9a1e7c5b28",
      properties: {
        customer_id: "c2a8e4f1-7b3d-4e9a-8c6f-1d5b9e3a7c24",
        alert_id: "e8b2d6f4-1c9a-4e7d-a3b5-9f2c6e1d8a47",
        timestamp: "2026-10-14T17:02:05.091Z",
        threshold: 10000,
        alert_name: "Monthly spend over $100",
        current_spend: 12475,
        triggered_by: "usage",
      },
      type: "alerts.spend_threshold_reached",
    },
    docsUrl: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "metronome",
    providerLabel: "Metronome",
    eventType: "contract.create",
    name: "Contract created",
    description:
      "A new contract was created for a customer (system notification, fields at top level).",
    body: {
      id: "3d8f1b6e-4a2c-5e9d-b7f3-8c1a6e4d2b95",
      type: "contract.create",
      timestamp: "2026-10-14T15:41:27Z",
      environment_type: "PRODUCTION",
      contract_id: "7e2c9a4f-1b8d-4f3e-a6c2-5d9b1e7a3f84",
      contract_custom_fields: {
        plan_key: "pro_annual",
      },
      customer_id: "c2a8e4f1-7b3d-4e9a-8c6f-1d5b9e3a7c24",
      customer_custom_fields: {
        crm_account_id: "0018d00000XyZ12AAB",
      },
    },
    docsUrl: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "metronome",
    providerLabel: "Metronome",
    eventType: "commit.segment.start",
    name: "Commit segment started",
    description:
      "A segment of a recurring commit began, refreshing the customer's committed balance.",
    body: {
      id: "b1f6c3a8-7d2e-5b4f-9a1c-6e3d8f2b7a51",
      type: "commit.segment.start",
      timestamp: "2026-10-01T00:00:00Z",
      environment_type: "PRODUCTION",
      commit_id: "5a9d2f7c-3e1b-5c8a-b4f6-2d7e9a1c5f38",
      commit_custom_fields: {
        tier_key: "growth",
      },
      contract_id: "7e2c9a4f-1b8d-4f3e-a6c2-5d9b1e7a3f84",
      contract_custom_fields: {
        plan_key: "pro_annual",
      },
      parent_recurring_commit_id: "8c4e1a7d-2f9b-4d6e-a3c5-1b7f9e2d4a63",
      segment_index: 9,
      segment_count: 12,
      segment_id: "f2a7c5e1-9d3b-5f8a-8e2c-4b6d1f9a7c35",
      customer_id: "c2a8e4f1-7b3d-4e9a-8c6f-1d5b9e3a7c24",
      customer_custom_fields: {
        crm_account_id: "0018d00000XyZ12AAB",
      },
    },
    docsUrl: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "metronome",
    providerLabel: "Metronome",
    eventType: "invoice.finalized",
    name: "Invoice finalized",
    description: "An invoice was finalized after its grace period ended.",
    body: {
      id: "e4c9a2f7-6b1d-4e8c-a5f3-7d2b9e6c1a84",
      properties: {
        invoice_id: "1f7b3e9d-5c2a-4b8f-9e6d-3a1c7f5b2e96",
        customer_id: "c2a8e4f1-7b3d-4e9a-8c6f-1d5b9e3a7c24",
        invoice_finalized_date: "2026-10-04T00:00:12.307Z",
      },
      type: "invoice.finalized",
    },
    docsUrl: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "metronome",
    providerLabel: "Metronome",
    eventType: "payment_gate.payment_status",
    name: "Payment gate status",
    description: "A payment attempt for a payment-gated commit failed at Stripe.",
    body: {
      id: "7a2d5f8c-1e4b-4c9a-b6e3-9f1d4a7c2e58",
      properties: {
        workflow_type: "manual_commit",
        customer_id: "c2a8e4f1-7b3d-4e9a-8c6f-1d5b9e3a7c24",
        contract_id: "7e2c9a4f-1b8d-4f3e-a6c2-5d9b1e7a3f84",
        invoice_id: "4b8e2c6a-9f3d-4a1e-8c7b-2d5f9a3e6c17",
        payment_status: "failed",
        timestamp: "2026-10-14T18:11:30Z",
        error_message: "Your card has insufficient funds.",
        billing_provider: {
          type: "stripe",
          stripe: {
            payment_intent_id: "pi_3QfAkeIntentTest00Ab12Cd",
            error: {
              type: "card_error",
              code: "card_declined",
              decline_code: "insufficient_funds",
              message: "Your card has insufficient funds.",
            },
          },
        },
      },
      type: "payment_gate.payment_status",
    },
    docsUrl: "https://docs.metronome.com/guides/platform-configuration/setup-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];

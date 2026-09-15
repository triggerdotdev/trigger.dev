import { type SampleRecord } from "../sampleRecord.js";

/**
 * Plaid samples. No `presetId` on any sample: Plaid's `Plaid-Verification` scheme is a JWT (ES256)
 * over a body hash, verified against a key fetched from `/webhook_verification_key/get`, not one of
 * our HMAC-shared-secret presets. `eventType` joins `webhook_type` and `webhook_code`
 * (e.g. "TRANSACTIONS.SYNC_UPDATES_AVAILABLE") to match `eventTypeSource`'s coarser `webhook_type`
 * pointer. Plaid's real API delivers "login required" as `webhook_code: "ERROR"` with a nested
 * `error.error_code: "ITEM_LOGIN_REQUIRED"` - there is no distinct top-level `LOGIN_REQUIRED`
 * webhook_code - so that sample's `eventType` further appends the nested error code to stay
 * distinguishable from the other, unrelated ITEM ERROR sample below.
 */
export const samples: SampleRecord[] = [
  {
    provider: "plaid",
    providerLabel: "Plaid",
    eventType: "TRANSACTIONS.SYNC_UPDATES_AVAILABLE",
    name: "Transactions sync update available",
    description:
      "Fires after `/transactions/sync` has new changes to fetch. `initial_update_complete` flips true once the first 30 days are ready; `historical_update_complete` flips true once up to 24 months of history has backfilled.",
    body: {
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "gY6VmvpXQPfBn8DjJ4koSA5rZ1MezyCWQ98po",
      initial_update_complete: true,
      historical_update_complete: false,
      environment: "production",
    },
    docsUrl: "https://plaid.com/docs/api/products/transactions/#sync_updates_available",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "plaid",
    providerLabel: "Plaid",
    eventType: "TRANSACTIONS.TRANSACTIONS_REMOVED",
    name: "Transactions removed",
    description:
      "Fires when previously-sent transactions are no longer valid, most commonly when a pending transaction is canceled rather than posting. `removed_transactions` lists the affected transaction ids.",
    body: {
      webhook_type: "TRANSACTIONS",
      webhook_code: "TRANSACTIONS_REMOVED",
      removed_transactions: [
        "a8N7bQeWnDx3fKpL9tYoI2vEcJmZ5RsAugTHb",
        "j3F1mXsPqRkV6bYtNc8oLwZdEgA0hUiCsxKMe",
      ],
      item_id: "gY6VmvpXQPfBn8DjJ4koSA5rZ1MezyCWQ98po",
      environment: "production",
    },
    docsUrl: "https://plaid.com/docs/transactions/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "plaid",
    providerLabel: "Plaid",
    eventType: "ITEM.ERROR",
    name: "Item error: institution not responding",
    description:
      "A generic Item-level error unrelated to the user's credentials; the institution's servers stopped responding to requests for this Item.",
    body: {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "gY6VmvpXQPfBn8DjJ4koSA5rZ1MezyCWQ98po",
      user_id: "usr_4hT9dNwXqYb2Lc7fVoAsJk1rGz6PmEuS",
      error: {
        error_type: "ITEM_ERROR",
        error_code: "INSTITUTION_NOT_RESPONDING",
        error_message: "the institution is not responding to requests for this item",
        display_message:
          "We're having trouble connecting to your bank's servers right now. We're working with them to fix it.",
        status: 400,
      },
      environment: "production",
    },
    docsUrl: "https://plaid.com/docs/api/items/#item-error-webhook",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "plaid",
    providerLabel: "Plaid",
    eventType: "ITEM.ERROR.ITEM_LOGIN_REQUIRED",
    name: "Item error: login required",
    description:
      "The user's credentials at the institution changed (password rotation, revoked OAuth consent, etc.) and Link's update mode is needed to restore the Item. Delivered as `webhook_code: ERROR` with `error.error_code: ITEM_LOGIN_REQUIRED` - Plaid has no separate top-level `LOGIN_REQUIRED` webhook_code.",
    body: {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "gY6VmvpXQPfBn8DjJ4koSA5rZ1MezyCWQ98po",
      user_id: "usr_4hT9dNwXqYb2Lc7fVoAsJk1rGz6PmEuS",
      error: {
        error_type: "ITEM_ERROR",
        error_code: "ITEM_LOGIN_REQUIRED",
        error_code_reason: "OAUTH_INVALID_TOKEN",
        error_message:
          "the login details of this item have changed (credentials, MFA, or required user action) and a user login is required to update this information. use Link's update mode to restore the item to a good state",
        display_message: "The user's OAuth connection to this institution has been invalidated.",
        status: 400,
      },
      environment: "production",
    },
    docsUrl: "https://plaid.com/docs/api/items/#item-error-webhook",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "plaid",
    providerLabel: "Plaid",
    eventType: "ITEM.PENDING_EXPIRATION",
    name: "Item pending expiration",
    description:
      "Warns that the user's OAuth consent to the institution will expire soon; `consent_expiration_time` (ISO 8601) is when access is cut off unless the user re-authenticates via update mode.",
    body: {
      webhook_type: "ITEM",
      webhook_code: "PENDING_EXPIRATION",
      item_id: "gY6VmvpXQPfBn8DjJ4koSA5rZ1MezyCWQ98po",
      user_id: "usr_4hT9dNwXqYb2Lc7fVoAsJk1rGz6PmEuS",
      consent_expiration_time: "2026-08-01T13:25:17.000Z",
      environment: "production",
    },
    docsUrl: "https://plaid.com/docs/api/items/#item-pending_expiration-webhook",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];

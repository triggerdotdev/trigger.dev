import { z } from "zod";
// Reuse the source-side enum (provider | integrator | either) rather than redefining it.
import { WebhookSecretProvisioning } from "./webhookConfig.js";

// Public HTTP API objects for webhooks (endpoints + deliveries). Read surface for now; the create
// path (dynamic endpoints) and lifecycle actions layer on later. Mirrors the Errors API shape:
// list endpoints return `{ data, pagination? }`, detail endpoints return the object directly.
// Statuses are exposed lowercase over the API (the DB enums are uppercase).

export const WebhookEndpointApiStatus = z.enum(["active", "inactive", "deleting"]);
export type WebhookEndpointApiStatus = z.infer<typeof WebhookEndpointApiStatus>;

export const WebhookDeliveryApiStatus = z.enum([
  "pending",
  "processing",
  "succeeded",
  "failed",
  "filtered",
]);
export type WebhookDeliveryApiStatus = z.infer<typeof WebhookDeliveryApiStatus>;

export const WebhookEndpointObject = z.object({
  /** Stable friendly id, e.g. `wh_...`. */
  id: z.string(),
  /** The declared webhook() id this endpoint routes to. */
  webhook: z.string(),
  /** Provider tag, e.g. "stripe" | "github" | "standard". */
  source: z.string(),
  status: WebhookEndpointApiStatus,
  /** Who supplies the secret/key; drives paste-vs-generate in the dashboard. */
  secretProvisioning: WebhookSecretProvisioning,
  /** Whether a signing secret/public key has been set. The value is never returned. */
  secretSet: z.boolean(),
  /** Tenant scope (P2 dynamic endpoints); null for the declared default endpoint. */
  tenantId: z.string().nullable(),
  externalRef: z.string().nullable(),
  /** The hosted ingress URL to point the provider at. */
  url: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type WebhookEndpointObject = z.infer<typeof WebhookEndpointObject>;

export const ListWebhookEndpointsResponse = z.object({
  data: z.array(WebhookEndpointObject),
});
export type ListWebhookEndpointsResponse = z.infer<typeof ListWebhookEndpointsResponse>;

export const WebhookDeliveryListItem = z.object({
  /** Stable friendly id, e.g. `whd_...`. */
  id: z.string(),
  /** The webhook() id this delivery was routed to, if resolvable. */
  webhook: z.string().nullable(),
  status: WebhookDeliveryApiStatus,
  /** Provider delivery id (Stripe event id, GitHub X-GitHub-Delivery, …). */
  externalDeliveryId: z.string(),
  /** The triggered run's friendly id, if any. */
  runId: z.string().nullable(),
  createdAt: z.coerce.date(),
  processedAt: z.coerce.date().nullable(),
});
export type WebhookDeliveryListItem = z.infer<typeof WebhookDeliveryListItem>;

export const ListWebhookDeliveriesResponse = z.object({
  data: z.array(WebhookDeliveryListItem),
  pagination: z.object({
    next: z.string().optional(),
    previous: z.string().optional(),
  }),
});
export type ListWebhookDeliveriesResponse = z.infer<typeof ListWebhookDeliveriesResponse>;

export const WebhookDeliveryObject = WebhookDeliveryListItem.extend({
  idempotencyKey: z.string(),
  /** The size-capped, verified event body. */
  event: z.unknown().nullable(),
  /** The inbound request headers. */
  headers: z.record(z.string(), z.string()).nullable(),
  rawBodyHash: z.string().nullable(),
  error: z.string().nullable(),
  /** For a `filtered` delivery: why it was not routed (failing clause + actual value). */
  filterReason: z.string().nullable(),
  updatedAt: z.coerce.date(),
});
export type WebhookDeliveryObject = z.infer<typeof WebhookDeliveryObject>;

// ── Write actions ──

/** Rotating/setting a signing secret returns the plaintext ONCE; it is never readable again. */
export const RotateWebhookEndpointSecretResponse = z.object({
  id: z.string(),
  secretSet: z.literal(true),
  secret: z.string(),
});
export type RotateWebhookEndpointSecretResponse = z.infer<
  typeof RotateWebhookEndpointSecretResponse
>;

/** Replaying re-runs a delivery's task from its stored event as a new delivery. */
export const ReplayWebhookDeliveryResponse = z.object({
  /** The new delivery's friendly id (GET it once processed for the run). */
  deliveryId: z.string(),
  /** The original delivery id the replay was created from. */
  replayedFrom: z.string(),
});
export type ReplayWebhookDeliveryResponse = z.infer<typeof ReplayWebhookDeliveryResponse>;

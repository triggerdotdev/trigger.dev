import { z } from "zod/v4";
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
  "unmatched",
]);
export type WebhookDeliveryApiStatus = z.infer<typeof WebhookDeliveryApiStatus>;

export const WebhookEndpointObject = z.object({
  /** Stable friendly id, e.g. `wh_...`. */
  id: z.string(),
  /** The id the endpoint is declared with in code (`webhooks.endpoint.define({ id })`). */
  declaredId: z.string(),
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

export const WebhookEndpointSubscriberObject = z.object({
  id: z.string(),
  type: z.enum(["task", "session"]),
  /** The subscribing task: the webhook() task, or the agent for a session subscriber. */
  taskId: z.string(),
  filter: z.string().nullable(),
});
export type WebhookEndpointSubscriberObject = z.infer<typeof WebhookEndpointSubscriberObject>;

export const WebhookEndpointDetailObject = WebhookEndpointObject.extend({
  subscribers: z.array(WebhookEndpointSubscriberObject),
  /** Instructions for an AI agent to register this endpoint with its provider. */
  setupPrompt: z.string(),
});
export type WebhookEndpointDetailObject = z.infer<typeof WebhookEndpointDetailObject>;

export const WebhookDeliveryListItem = z.object({
  /** Stable friendly id, e.g. `whd_...`. */
  id: z.string(),
  /** The endpoint the delivery arrived on, or null if it has since been removed. */
  endpoint: z.object({ id: z.string(), declaredId: z.string() }).nullable(),
  status: WebhookDeliveryApiStatus,
  /** Provider delivery id (Stripe event id, GitHub X-GitHub-Delivery, …). */
  externalDeliveryId: z.string(),
  isTest: z.boolean(),
  createdAt: z.coerce.date(),
  processedAt: z.coerce.date().nullable(),
});
export type WebhookDeliveryListItem = z.infer<typeof WebhookDeliveryListItem>;

/** Query for `GET /api/v1/webhooks/deliveries`, newest first. */
export type ListWebhookDeliveriesQuery = {
  /** Declared endpoint ids or `wh_` ids. */
  endpoint?: string | string[];
  status?: WebhookDeliveryApiStatus | WebhookDeliveryApiStatus[];
  /** A duration back from now, such as `"1h"` or `"7d"`. */
  period?: string;
  from?: Date;
  to?: Date;
  /** 1 to 100. */
  limit?: number;
  /** The `pagination.next` cursor from a previous page. */
  after?: string;
};

export const ListWebhookDeliveriesResponse = z.object({
  data: z.array(WebhookDeliveryListItem),
  pagination: z.object({
    next: z.string().optional(),
    previous: z.string().optional(),
  }),
});
export type ListWebhookDeliveriesResponse = z.infer<typeof ListWebhookDeliveriesResponse>;

export const WebhookDeliveryTargetApiStatus = z.enum([
  "pending",
  "succeeded",
  "failed",
  "filtered",
]);
export type WebhookDeliveryTargetApiStatus = z.infer<typeof WebhookDeliveryTargetApiStatus>;

/**
 * What a delivery did for one subscriber, or (type `waiter`) the summary of the waiting runs it
 * matched. `runId` and `sessionId` are friendly ids.
 */
export const WebhookDeliveryTargetObject = z.object({
  /** The subscriber id on the endpoint, or `waiters` for the waiter summary. */
  id: z.string(),
  type: z.enum(["task", "session", "waiter"]),
  status: WebhookDeliveryTargetApiStatus,
  /** Why a filtered target skipped the event. */
  reason: z.string().nullable(),
  error: z.string().nullable(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  /** For the waiter summary: waiting runs matched, resumed, and given up on. */
  waiters: z.object({ matched: z.number(), resumed: z.number(), failed: z.number() }).nullable(),
});
export type WebhookDeliveryTargetObject = z.infer<typeof WebhookDeliveryTargetObject>;

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
  /** One entry per subscriber, plus a waiter summary when waiting runs matched. */
  targets: z.array(WebhookDeliveryTargetObject),
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

/** `PUT /api/v1/webhooks/endpoints/:endpointId/secret`: store a secret or public key the provider issued. */
export const SetWebhookEndpointSecretRequestBody = z.object({
  secret: z.string().trim().min(1).max(4096),
});
export type SetWebhookEndpointSecretRequestBody = z.infer<
  typeof SetWebhookEndpointSecretRequestBody
>;

export const SetWebhookEndpointSecretResponse = z.object({
  id: z.string(),
  secretSet: z.literal(true),
});
export type SetWebhookEndpointSecretResponse = z.infer<typeof SetWebhookEndpointSecretResponse>;

/** Replaying re-runs a delivery's task from its stored event as a new delivery. */
export const ReplayWebhookDeliveryResponse = z.object({
  /** The new delivery's friendly id (GET it once processed for the run). */
  deliveryId: z.string(),
  /** The original delivery id the replay was created from. */
  replayedFrom: z.string(),
});
export type ReplayWebhookDeliveryResponse = z.infer<typeof ReplayWebhookDeliveryResponse>;

// ── Webhook waiters ──

/**
 * `POST /api/v1/webhooks/endpoints/:endpointId/waiters`, where `:endpointId` is the declared endpoint
 * id or its `wh_` id. A waiter only matches deliveries that arrive after it was created.
 */
export const CreateWebhookWaiterRequestBody = z.object({
  /** Paths to expected values: `event.*` reads the body, `header.*` a header and `webhook.*` the endpoint. Omit for a URL-matched waiter. */
  match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  /** A filter the event must also pass, checked after `match`. */
  filter: z.string().optional(),
  /** A duration (`"1h"`) or an ISO date. Default 24 hours, maximum 90 days. */
  timeout: z.string().optional(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  idempotencyKey: z.string().optional(),
  idempotencyKeyTTL: z.string().optional(),
  /** Selects a dynamic endpoint instance. Reserved: only the declared instance is supported. */
  endpoint: z
    .object({ tenantId: z.string().optional(), externalRef: z.string().optional() })
    .optional(),
});
export type CreateWebhookWaiterRequestBody = z.infer<typeof CreateWebhookWaiterRequestBody>;

export const CreateWebhookWaiterResponseBody = z.object({
  /** The waiter id, which is also its waitpoint id. */
  id: z.string(),
  /** For a URL-matched waiter: the URL to hand the provider as its per-request callback. */
  url: z.string().optional(),
  expiresAt: z.coerce.date(),
  isCached: z.boolean(),
});
export type CreateWebhookWaiterResponseBody = z.infer<typeof CreateWebhookWaiterResponseBody>;

export const WebhookWaiterErrorCode = z.enum([
  "webhook_waiter_limit",
  "webhook_endpoint_not_found",
  "webhook_filter_invalid",
  "invalid_request",
]);
export type WebhookWaiterErrorCode = z.infer<typeof WebhookWaiterErrorCode>;

export const WebhookWaiterErrorResponseBody = z.object({
  error: z.string(),
  code: WebhookWaiterErrorCode,
  /** For `webhook_waiter_limit`: which limit. */
  reason: z
    .enum(["environment_limit", "endpoint_limit", "shape_limit", "timeout_too_long"])
    .optional(),
});
export type WebhookWaiterErrorResponseBody = z.infer<typeof WebhookWaiterErrorResponseBody>;

/** `POST /api/v1/webhooks/waiters/:waiterId/cancel`. `too_late`: a delivery already claimed it. */
export const CancelWebhookWaiterResponseBody = z.object({
  cancelled: z.boolean(),
  reason: z.literal("too_late").optional(),
  deliveryId: z.string().optional(),
});
export type CancelWebhookWaiterResponseBody = z.infer<typeof CancelWebhookWaiterResponseBody>;

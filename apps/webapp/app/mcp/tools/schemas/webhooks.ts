import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const EndpointInput = CommonProjectsInput.extend({
  endpointId: z
    .string()
    .describe(
      "The webhook endpoint: its declared id (e.g. payments) or wh_ id. Use list_webhook_endpoints to find it."
    ),
});

const DELIVERY_STATUSES = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "filtered",
  "unmatched",
] as const;

export const ListDeliveriesInput = CommonProjectsInput.extend({
  endpointId: z
    .string()
    .describe("Only this endpoint's deliveries: its declared id (e.g. payments) or wh_ id.")
    .optional(),
  status: z
    .array(z.enum(DELIVERY_STATUSES))
    .describe('Only deliveries with these statuses, e.g. ["failed", "filtered"].')
    .optional(),
  period: z
    .string()
    .describe('How far back to look, e.g. "1h", "1d" or "7d". Defaults to 7d.')
    .optional(),
  limit: z.number().int().min(1).max(100).describe("How many to return (default 20).").optional(),
  cursor: z
    .string()
    .describe("The cursor from a previous call, to get the next page of older deliveries.")
    .optional(),
});

export const DeliveryInput = CommonProjectsInput.extend({
  deliveryId: z
    .string()
    .describe("The delivery id, starting with whd_. Use list_webhook_deliveries to find it."),
});

export const EndpointWriteInput = CommonProjectsInput.extend({
  endpointId: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "The webhook endpoint: its declared id (e.g. payments) or wh_ id. Use search_webhook_endpoints to find it."
    ),
});

export const TaskWebhookInput = CommonProjectsInput.extend({
  taskId: z
    .string()
    .max(200)
    .describe("The webhook task's id, as passed to webhook() in your code (e.g. stripe-orders)."),
});

export const ListWaitersInput = EndpointInput.extend({
  limit: z.number().int().min(1).max(50).describe("How many to return (default 20).").optional(),
  cursor: z
    .string()
    .regex(/^\d{1,6}$/)
    .describe("The cursor from a previous call, to get the next page.")
    .optional(),
});

export const SearchEndpointsInput = CommonProjectsInput.extend({
  subscribers: z
    .array(z.string().max(200))
    .max(20)
    .describe("Only endpoints one of these subscribers (task or agent ids) subscribes to.")
    .optional(),
  sources: z
    .array(z.string().max(100))
    .max(20)
    .describe('Only endpoints from these provider sources, e.g. ["stripe"].')
    .optional(),
  statuses: z
    .array(z.enum(["active", "inactive", "disabled"]))
    .describe('Only endpoints with these statuses. Defaults to ["active"].')
    .optional(),
  search: z
    .string()
    .max(200)
    .describe("Text to find in the declared id, tenant id or external ref.")
    .optional(),
  cursor: z
    .string()
    .max(2000)
    .describe("The cursor from a previous call, to get the next page.")
    .optional(),
});

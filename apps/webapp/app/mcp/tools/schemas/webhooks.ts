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

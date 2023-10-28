import { z } from "zod";
import { WebhookEventTypeSchema } from "./types";

const WebhookEventBaseSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  region: z.string().optional(),
});

const DeploymentPayloadBaseSchema = z.object({
  name: z.string(),
  plan: z.string(),
  url: z.string(),
  type: z.string(),
  target: z.union([z.literal("production"), z.literal("staging"), z.null()]),
  regions: z.array(z.string()),
  user: z.object({
    id: z.string(),
  }),
  team: z
    .object({
      id: z.string().optional(),
    })
    .optional(),
  project: z.object({
    id: z.string(),
  }),
  deployment: z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    inspectorUrl: z.string(),
    meta: z.record(z.any()),
  }),
  links: z.object({
    deployment: z.string(),
    project: z.string(),
  }),
});

const DeploymentCreatedEventSchema = WebhookEventBaseSchema.extend({
  type: z.literal(WebhookEventTypeSchema.enum["deployment.created"]),
  payload: DeploymentPayloadBaseSchema.extend({
    alias: z.array(z.string()),
  }),
});

const DeploymentSucceededEventSchema = WebhookEventBaseSchema.extend({
  type: z.literal(WebhookEventTypeSchema.enum["deployment.succeeded"]),
  payload: DeploymentPayloadBaseSchema,
});

const DeploymentReadyEventSchema = WebhookEventBaseSchema.extend({
  type: z.literal(WebhookEventTypeSchema.enum["deployment.ready"]),
  payload: DeploymentPayloadBaseSchema,
});

const DeploymentCancelledEventSchema = WebhookEventBaseSchema.extend({
  type: z.literal(WebhookEventTypeSchema.enum["deployment.canceled"]),
  payload: DeploymentPayloadBaseSchema,
});

const DeploymentFailedEventSchema = WebhookEventBaseSchema.extend({
  type: z.literal(WebhookEventTypeSchema.enum["deployment.error"]),
  payload: DeploymentPayloadBaseSchema,
});

const DeploymentEventSchema = z.discriminatedUnion("type", [
  DeploymentCreatedEventSchema,
  DeploymentSucceededEventSchema,
  DeploymentReadyEventSchema,
  DeploymentCancelledEventSchema,
  DeploymentFailedEventSchema,
]);

export const WebhookEventSchema = z.union([DeploymentEventSchema, DeploymentEventSchema]);

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

type DeploymentCreatedEvent = z.infer<typeof DeploymentCreatedEventSchema>;

export type DeploymentCreatedEventPayload = DeploymentCreatedEvent["payload"];

type DeploymentSucceededEvent = z.infer<typeof DeploymentCreatedEventSchema>;

export type DeploymentSucceededEventPayload = DeploymentSucceededEvent["payload"];

export type DeploymentEventPayload =
  | DeploymentCreatedEventPayload
  | DeploymentSucceededEventPayload;

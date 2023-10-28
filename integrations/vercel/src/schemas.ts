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

const DeploymentCanceledEventSchema = WebhookEventBaseSchema.extend({
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
  DeploymentCanceledEventSchema,
  DeploymentFailedEventSchema,
]);

export const WebhookEventSchema = z.union([DeploymentEventSchema, DeploymentEventSchema]);

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

type WebhookEventPayload<TWebhookEvent extends { payload: any }> = TWebhookEvent["payload"];

export type DeploymentCreatedEventPayload = WebhookEventPayload<
  z.infer<typeof DeploymentCreatedEventSchema>
>;

export type DeploymentSucceededEventPayload = WebhookEventPayload<
  z.infer<typeof DeploymentSucceededEventSchema>
>;

export type DeploymentReadyEventPayload = WebhookEventPayload<
  z.infer<typeof DeploymentReadyEventSchema>
>;

export type DeploymentCanceledEventPayload = WebhookEventPayload<
  z.infer<typeof DeploymentCanceledEventSchema>
>;

export type DeploymentEventPayload =
  | DeploymentCreatedEventPayload
  | DeploymentSucceededEventPayload
  | DeploymentReadyEventPayload
  | DeploymentCanceledEventPayload;

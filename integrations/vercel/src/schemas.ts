import { z } from "zod";
import { WebhookEventTypeSchema } from "./types";

const WebhookEventBaseSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  eventRegion: z.string().optional(),
});

const DeploymentPayloadBaseSchema = z.object({
  deploymentId: z.string(),
  deploymentUrl: z.string(),
  deploymentUrlOnDashboard: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  projectUrlOnDashboard: z.string(),
  userId: z.array(z.any()),
  teamId: z.array(z.any()).optional(),
  environment: z.enum(["production", "staging"]),
  planType: z.string(),
  supportedRegions: z.array(z.any()),
  metadata: z.record(z.any()),
});

const DeploymentCreatedEventSchema = WebhookEventBaseSchema.extend({
  type: z.literal(WebhookEventTypeSchema.enum["deployment.created"]),
  payload: DeploymentPayloadBaseSchema.extend({
    alias: z.array(z.any()),
  }),
});

export type DeploymentCreatedEvent = z.infer<typeof DeploymentCreatedEventSchema>;

const DeploymentSucceededEventSchema = WebhookEventBaseSchema.extend({
  type: z.literal(WebhookEventTypeSchema.enum["deployment.succeeded"]),
  payload: DeploymentPayloadBaseSchema,
});

export type DeploymentSucceededEvent = z.infer<typeof DeploymentCreatedEventSchema>;

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

export type DeploymentEvent = z.infer<typeof DeploymentEventSchema>;

export const WebhookPayloadSchema = z.union([DeploymentEventSchema, DeploymentEventSchema]);

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

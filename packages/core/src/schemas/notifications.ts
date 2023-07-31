import { z } from "zod";

export const MISSING_CONNECTION_NOTIFICATION =
  "dev.trigger.notifications.missingConnection";

export const MISSING_CONNECTION_RESOLVED_NOTIFICATION =
  "dev.trigger.notifications.missingConnectionResolved";

export const CommonMissingConnectionNotificationPayloadSchema = z.object({
  id: z.string(),
  client: z.object({
    id: z.string(),
    title: z.string(),
    scopes: z.array(z.string()),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  }),
  authorizationUrl: z.string(),
});

export const MissingDeveloperConnectionNotificationPayloadSchema =
  CommonMissingConnectionNotificationPayloadSchema.extend({
    type: z.literal("DEVELOPER"),
  });

export const MissingExternalConnectionNotificationPayloadSchema =
  CommonMissingConnectionNotificationPayloadSchema.extend({
    type: z.literal("EXTERNAL"),
    account: z.object({
      id: z.string(),
      metadata: z.any(),
    }),
  });

export const MissingConnectionNotificationPayloadSchema = z.discriminatedUnion(
  "type",
  [
    MissingDeveloperConnectionNotificationPayloadSchema,
    MissingExternalConnectionNotificationPayloadSchema,
  ]
);

export type MissingConnectionNotificationPayload = z.infer<
  typeof MissingConnectionNotificationPayloadSchema
>;

export const CommonMissingConnectionNotificationResolvedPayloadSchema =
  z.object({
    id: z.string(),
    client: z.object({
      id: z.string(),
      title: z.string(),
      scopes: z.array(z.string()),
      createdAt: z.coerce.date(),
      updatedAt: z.coerce.date(),
      integrationIdentifier: z.string(),
      integrationAuthMethod: z.string(),
    }),
    expiresAt: z.coerce.date(),
  });

export const MissingDeveloperConnectionResolvedNotificationPayloadSchema =
  CommonMissingConnectionNotificationResolvedPayloadSchema.extend({
    type: z.literal("DEVELOPER"),
  });

export const MissingExternalConnectionResolvedNotificationPayloadSchema =
  CommonMissingConnectionNotificationResolvedPayloadSchema.extend({
    type: z.literal("EXTERNAL"),
    account: z.object({
      id: z.string(),
      metadata: z.any(),
    }),
  });

export const MissingConnectionResolvedNotificationPayloadSchema =
  z.discriminatedUnion("type", [
    MissingDeveloperConnectionResolvedNotificationPayloadSchema,
    MissingExternalConnectionResolvedNotificationPayloadSchema,
  ]);

export type MissingConnectionResolvedNotificationPayload = z.infer<
  typeof MissingConnectionResolvedNotificationPayloadSchema
>;

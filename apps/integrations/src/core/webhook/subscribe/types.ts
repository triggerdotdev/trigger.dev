import { z } from "zod";

const OAuthSchema = z.object({
  type: z.literal("oauth"),
  connectionId: z.string(),
});

const APIKeySchema = z.object({
  type: z.literal("api-key"),
  api_key: z.string(),
});

const AuthenticationSchema = z.discriminatedUnion("type", [
  OAuthSchema,
  APIKeySchema,
]);

const ServiceSchema = z.object({
  type: z.literal("service"),
  consumerId: z.string(),
  callbackUrl: z.string().url(),
  service: z.string(),
  authentication: AuthenticationSchema,
  data: z.record(z.any()),
  eventName: z.string(),
});

const GenericSchema = z.object({
  type: z.literal("generic"),
  consumerId: z.string(),
  callbackUrl: z.string().url(),
  eventName: z.string(),
  schema: z.any(),
  verifyPayload: z.object({
    enabled: z.boolean(),
    header: z.string().optional(),
  }),
});

export const SubscribeInputSchema = z.discriminatedUnion("type", [
  ServiceSchema,
  GenericSchema,
]);

export type SubscribeServiceInput = z.infer<typeof ServiceSchema>;
export type SubscribeGenericInput = z.infer<typeof GenericSchema>;

export type SubscribeInput = z.infer<typeof SubscribeInputSchema>;

export type SubscribeResult =
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
    }
  | {
      success: true;
      result:
        | {
            type: "service";
            webhookId: string;
            subscription:
              | {
                  type: "automatic";
                }
              | {
                  type: "manual";
                  url: string;
                  secret?: string;
                };
          }
        | {
            type: "generic";
            webhookId: string;
            url: string;
            secret?: string;
          };
    };

import { z } from "zod";

const ServiceSchema = z.object({
  type: z.literal("service"),
  consumerId: z.string(),
  callbackUrl: z.string().url(),
  service: z.string(),
  authentication: z.object({
    type: z.literal("oauth"),
    connectionId: z.string(),
  }),
  data: z.record(z.any()),
  events: z.array(z.string()),
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
          }
        | {
            type: "generic";
            webhookId: string;
            url: string;
            secret?: string;
          };
    };

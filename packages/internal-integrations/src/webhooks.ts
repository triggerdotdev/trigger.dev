import { z } from "zod";

export function createWebhookConfig<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  id: string,
  webhook: any
): { id: string; webhook: z.infer<TSchema> } {
  return {
    id,
    webhook: schema.parse(webhook),
  };
}

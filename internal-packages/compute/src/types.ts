import { z } from "zod";

export const TemplateCreateRequestSchema = z.object({
  image: z.string(),
  cpu: z.number(),
  memory_mb: z.number(),
  callback: z
    .object({
      url: z.string(),
      metadata: z.record(z.string()).optional(),
    })
    .optional(),
});
export type TemplateCreateRequest = z.infer<typeof TemplateCreateRequestSchema>;

export const TemplateCallbackPayloadSchema = z.object({
  template_id: z.string().optional(),
  image: z.string(),
  status: z.enum(["completed", "failed"]),
  error: z.string().optional(),
  metadata: z.record(z.string()).optional(),
  duration_ms: z.number().optional(),
});
export type TemplateCallbackPayload = z.infer<typeof TemplateCallbackPayloadSchema>;

import { z } from "zod";

const SimplifiedReactElementSchema = z.object({
  type: z.any(),
  props: z.any(),
  key: z.union([z.string(), z.number()]).nullable(),
});

export const BaseSendFieldsSchema = z.object({
  from: z.string(),
  to: z.union([z.string(), z.array(z.string())]),
  bcc: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  replyTo: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().optional(),
});

export const SendEmailOptionsSchema = z
  .object({
    text: z.string().optional(),
    html: z.string().optional(),
    react: SimplifiedReactElementSchema.optional(),
  })
  .and(BaseSendFieldsSchema);

export const SendEmailBodySchema = BaseSendFieldsSchema.omit({
  replyTo: true,
}).and(
  z.object({
    reply_to: z.string().optional(),
    text: z.string().optional(),
    html: z.string().optional(),
  })
);

export const SendEmailSuccessResponseSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  created_at: z.string().optional(),
});
export const SendEmailErrorResponseSchema = z.object({
  error: z.object({ code: z.number(), type: z.string(), message: z.string() }),
});
export const SendEmailResponseSchema = z.union([
  SendEmailSuccessResponseSchema,
  SendEmailErrorResponseSchema,
]);

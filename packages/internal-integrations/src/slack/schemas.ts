import { z } from "zod";

export const PostMessageResponseSchema = z.object({
  ok: z.boolean(),
  channel: z.string(),
  ts: z.string(),
  message: z.object({
    text: z.string(),
    username: z.string(),
    bot_id: z.string(),
    attachments: z.array(z.unknown()),
    type: z.string(),
    subtype: z.string(),
    ts: z.string(),
  }),
});

export const PostMessageBodySchema = z.object({
  channel: z.string(),
  text: z.string(),
});

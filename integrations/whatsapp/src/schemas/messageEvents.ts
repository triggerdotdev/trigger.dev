import { z } from "zod";

const metadataSchema = z.object({
  display_phone_number: z.string(),
  phone_number_id: z.string(),
});

const contactSchema = z.object({
  profile: z.object({ name: z.string() }),
  wa_id: z.string(),
});

const commonMessageData = z.object({
  id: z.string(),
  from: z.string(),
  timestamp: z.coerce.date(),
});

const textMessageEventSchema = z.object({
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

const audioMessageEventSchema = z.object({
  type: z.literal("audio"),
  audio: z.object({
    id: z.string(),
    mime_type: z.string(),
  }),
});

const messageSchema = z
  .discriminatedUnion("type", [textMessageEventSchema, audioMessageEventSchema])
  .and(commonMessageData);

export const messageEventSchema = z.object({
  type: z.literal("message"),
  contacts: z.array(contactSchema),
  metadata: metadataSchema,
  message: messageSchema,
});

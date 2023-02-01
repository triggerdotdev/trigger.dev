import { z } from "zod";
import { sharedContactSchema } from "./shared";

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
  context: z
    .object({
      id: z.string(),
      from: z.string(),
    })
    .optional(),
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
    sha256: z.string().optional(),
    voice: z.boolean().optional(),
  }),
});

const videoMessageEventSchema = z.object({
  type: z.literal("video"),
  video: z.object({
    id: z.string(),
    mime_type: z.string(),
    sha256: z.string().optional(),
  }),
});

const imageMessageEventSchema = z.object({
  type: z.literal("image"),
  image: z.object({
    id: z.string(),
    mime_type: z.string(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
  }),
});

const reactionMessageEventSchema = z.object({
  type: z.literal("reaction"),
  reaction: z.object({
    emoji: z.string(),
    message_id: z.string(),
  }),
});

const stickerMessageEventSchema = z.object({
  type: z.literal("sticker"),
  sticker: z.object({
    id: z.string(),
    sha256: z.string(),
    animated: z.boolean(),
    mime_type: z.string(),
  }),
});

const documentMessageEventSchema = z.object({
  type: z.literal("document"),
  document: z.object({
    id: z.string(),
    mime_type: z.string(),
    sha256: z.string().optional(),
    filename: z.string().optional(),
    caption: z.string().optional(),
  }),
});

const locationMessageEventSchema = z.object({
  type: z.literal("location"),
  location: z.object({
    latitude: z.number(),
    longitude: z.number(),
    name: z.string().optional(),
    address: z.string().optional(),
    url: z.string().optional(),
  }),
});

const contactsMessageEventSchema = z.object({
  type: z.literal("contacts"),
  contacts: z.array(sharedContactSchema),
});

const unsupportedMessageEventSchema = z.object({
  type: z.literal("unsupported"),
  errors: z.array(z.object({ code: z.number(), title: z.string() })),
});

const messageSchema = z
  .discriminatedUnion("type", [
    textMessageEventSchema,
    audioMessageEventSchema,
    imageMessageEventSchema,
    videoMessageEventSchema,
    reactionMessageEventSchema,
    stickerMessageEventSchema,
    documentMessageEventSchema,
    locationMessageEventSchema,
    contactsMessageEventSchema,
    unsupportedMessageEventSchema,
  ])
  .and(commonMessageData);

export const messageEventSchema = z.object({
  type: z.literal("message"),
  contacts: z.array(contactSchema),
  metadata: metadataSchema,
  message: messageSchema,
});

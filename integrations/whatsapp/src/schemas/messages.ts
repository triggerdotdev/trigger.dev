import { z } from "zod";
import { sharedContactSchema } from "./shared";

const TextParameter = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const CurrencyParameter = z.object({
  type: z.literal("currency"),
  currency: z.object({
    amount_1000: z.number(),
    code: z.string(),
    fallback_value: z.string(),
  }),
});

const DateTimeParameter = z.object({
  type: z.literal("date_time"),
  date_time: z.object({
    fallback_value: z.string(),
  }),
});

const MediaObject = z.object({
  link: z.string(),
  caption: z.string().optional(),
});

const ImageParameter = z.object({
  type: z.literal("image"),
  image: MediaObject,
});

const VideoParameter = z.object({
  type: z.literal("video"),
  video: MediaObject,
});

const DocumentParameter = z.object({
  type: z.literal("document"),
  video: MediaObject,
});

const ButtonTemplateComponent = z.object({
  type: z.literal("button"),
  sub_type: z.union([z.literal("quick_reply"), z.literal("call_to_action")]),
  index: z.number(),
  parameters: z.array(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("payload"),
        payload: z.string(),
      }),
      z.object({
        type: z.literal("text"),
        text: z.string(),
      }),
    ])
  ),
});

const LocationObject = z.object({
  latitude: z.number(),
  longitude: z.number(),
  name: z.string().optional(),
  address: z.string().optional(),
});

const HeaderParameters = z
  .discriminatedUnion("type", [
    TextParameter,
    ImageParameter,
    VideoParameter,
    DocumentParameter,
  ])
  .array();

const HeaderTemplateComponent = z.object({
  type: z.literal("header"),
  parameters: HeaderParameters,
});

const BodyParameters = z.array(
  z.discriminatedUnion("type", [
    TextParameter,
    CurrencyParameter,
    DateTimeParameter,
  ])
);

const BodyTemplateComponent = z.object({
  type: z.literal("body"),
  parameters: BodyParameters,
});

export const SendTemplateMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("template"),
  template: z.object({
    name: z.string(),
    language: z.object({
      code: z.string(),
      policy: z.literal("deterministic"),
    }),
    components: z
      .array(
        z.discriminatedUnion("type", [
          HeaderTemplateComponent,
          BodyTemplateComponent,
          ButtonTemplateComponent,
        ])
      )
      .optional(),
  }),
});

export const SendTemplateMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  template: z.string(),
  languageCode: z.string(),
  parameters: z
    .object({
      header: HeaderParameters.optional(),
      body: BodyParameters.optional(),
      buttons: z
        .array(ButtonTemplateComponent.omit({ type: true, index: true }))
        .optional(),
    })
    .optional(),
});

export const SendMessageErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string(),
      type: z.string(),
      code: z.number(),
      error_data: z
        .object({
          messaging_product: z.string(),
          details: z.string(),
        })
        .optional(),
      error_subcode: z.number().optional(),
      fbtrace_id: z.string(),
    }),
  })
  .passthrough();

export const SendMessageSuccessResponseSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  contacts: z.array(z.object({ input: z.string(), wa_id: z.string() })),
  messages: z.array(z.object({ id: z.string() })),
});

export const SendMessageResponseSchema = z.union([
  SendMessageErrorResponseSchema,
  SendMessageSuccessResponseSchema,
]);

const MessageContextSchema = z
  .object({
    message_id: z.string(),
  })
  .optional();

export const SendTextMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("text"),
  text: z.object({
    body: z.string(),
    preview_url: z.boolean(),
  }),
  context: MessageContextSchema,
});

export const SendTextMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  text: z.string(),
  preview_url: z.boolean().optional(),
  isReplyTo: z.string().optional(),
});

export const SendReactionMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("reaction"),
  reaction: z.object({
    message_id: z.string(),
    emoji: z.string(),
  }),
});

export const SendReactionMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  isReplyTo: z.string(),
  emoji: z.string(),
});

export const SendImageMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("image"),
  image: MediaObject,
  context: MessageContextSchema,
});

export const SendImageMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  url: z.string(),
  caption: z.string().optional(),
  isReplyTo: z.string().optional(),
});

export const SendVideoMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("video"),
  video: MediaObject,
  context: MessageContextSchema,
});

export const SendVideoMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  url: z.string(),
  caption: z.string().optional(),
  isReplyTo: z.string().optional(),
});

export const SendAudioMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("audio"),
  audio: MediaObject.omit({ caption: true }),
  context: MessageContextSchema,
});

export const SendAudioMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  url: z.string(),
  isReplyTo: z.string().optional(),
});

export const SendDocumentMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("document"),
  document: MediaObject,
  context: MessageContextSchema,
});

export const SendDocumentMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  url: z.string(),
  caption: z.string().optional(),
  isReplyTo: z.string().optional(),
});

export const SendStickerMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("sticker"),
  sticker: MediaObject,
  context: MessageContextSchema,
});

export const SendStickerMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  url: z.string(),
  caption: z.string().optional(),
  isReplyTo: z.string().optional(),
});

export const SendLocationMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("location"),
  location: LocationObject,
  context: MessageContextSchema,
});

export const SendLocationMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  name: z.string().optional(),
  address: z.string().optional(),
  isReplyTo: z.string().optional(),
});

export const SendContactsMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("contacts"),
  contacts: z.array(sharedContactSchema),
  context: MessageContextSchema,
});

export const SendContactsMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  contacts: z.array(sharedContactSchema),
  isReplyTo: z.string().optional(),
});

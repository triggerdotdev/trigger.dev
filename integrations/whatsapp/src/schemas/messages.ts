import { z } from "zod";

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

const ImageParameter = z.object({
  type: z.literal("image"),
  image: z.object({
    link: z.string(),
    caption: z.string().optional(),
  }),
});

const VideoParameter = z.object({
  type: z.literal("video"),
  video: z.object({
    link: z.string(),
    caption: z.string().optional(),
  }),
});

const DocumentParameter = z.object({
  type: z.literal("document"),
  video: z.object({
    link: z.string(),
    caption: z.string().optional(),
  }),
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

export const SendMessageResponseSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  contacts: z.array(z.object({ input: z.string(), wa_id: z.string() })),
  messages: z.array(z.object({ id: z.string() })),
});

export const SendTextMessageRequestBodySchema = z.object({
  messaging_product: z.literal("whatsapp"),
  recipient_type: z.literal("individual"),
  to: z.string(),
  type: z.literal("text"),
  text: z.object({
    body: z.string(),
    preview_url: z.boolean(),
  }),
});

export const SendTextMessageBodySchema = z.object({
  fromId: z.string(),
  to: z.string(),
  text: z.string(),
  preview_url: z.boolean().optional(),
});

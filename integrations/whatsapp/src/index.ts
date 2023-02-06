import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import * as events from "./events";
import { schemas } from "./internal";
export { events };

export type MessageEvent = z.infer<
  typeof schemas.messageEvents.messageEventSchema
>;

export type MessageEventMessage = MessageEvent["message"];

export type SendTemplateMessageOptions = z.infer<
  typeof schemas.messages.SendTemplateMessageBodySchema
>;

export type SendTemplateMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendTemplate(
  key: string,
  message: SendTemplateMessageOptions
): Promise<SendTemplateMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendTemplate outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendTemplate",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendTextMessageOptions = z.infer<
  typeof schemas.messages.SendTextMessageBodySchema
>;

export type SendTextMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendText(
  key: string,
  message: SendTextMessageOptions
): Promise<SendTextMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendText outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendText",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendReactionMessageOptions = z.infer<
  typeof schemas.messages.SendReactionMessageBodySchema
>;

export type SendReactionMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendReaction(
  key: string,
  message: SendReactionMessageOptions
): Promise<SendReactionMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendReaction outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendReaction",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendImageMessageOptions = z.infer<
  typeof schemas.messages.SendImageMessageBodySchema
>;

export type SendImageMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendImage(
  key: string,
  message: SendImageMessageOptions
): Promise<SendImageMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendImage outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendImage",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendAudioMessageOptions = z.infer<
  typeof schemas.messages.SendAudioMessageBodySchema
>;

export type SendAudioMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendAudio(
  key: string,
  message: SendAudioMessageOptions
): Promise<SendAudioMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendAudio outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendAudio",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendVideoMessageOptions = z.infer<
  typeof schemas.messages.SendVideoMessageBodySchema
>;

export type SendVideoMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendVideo(
  key: string,
  message: SendVideoMessageOptions
): Promise<SendVideoMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendVideo outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendVideo",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendDocumentMessageOptions = z.infer<
  typeof schemas.messages.SendDocumentMessageBodySchema
>;

export type SendDocumentMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendDocument(
  key: string,
  message: SendDocumentMessageOptions
): Promise<SendDocumentMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendDocument outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendDocument",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendStickerMessageOptions = z.infer<
  typeof schemas.messages.SendStickerMessageBodySchema
>;

export type SendStickerMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendSticker(
  key: string,
  message: SendStickerMessageOptions
): Promise<SendStickerMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendSticker outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendSticker",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendLocationMessageOptions = z.infer<
  typeof schemas.messages.SendLocationMessageBodySchema
>;

export type SendLocationMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendLocation(
  key: string,
  message: SendLocationMessageOptions
): Promise<SendLocationMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendLocation outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendLocation",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type SendContactsMessageOptions = z.infer<
  typeof schemas.messages.SendContactsMessageBodySchema
>;

export type SendContactsMessageResponse = z.infer<
  typeof schemas.messages.SendMessageSuccessResponseSchema
>;

export async function sendContacts(
  key: string,
  message: SendContactsMessageOptions
): Promise<SendContactsMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendContacts outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "message.sendContacts",
    params: message,
    response: {
      schema: schemas.messages.SendMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type GetMediaUrlOptions = z.infer<
  typeof schemas.messageEvents.EventMediaObjectSchema
>;

export async function getMediaUrl(
  key: string,
  options: GetMediaUrlOptions
): Promise<string> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call getMediaUrl outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "whatsapp",
    endpoint: "media.getUrl",
    params: options,
    response: {
      schema: z.string(),
    },
  });

  return output;
}

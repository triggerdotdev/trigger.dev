import { getTriggerRun } from "@trigger.dev/sdk/index";
import { z } from "zod";
import * as events from "./events";
import { schemas } from "./internal";
export { events };

export type SendTemplateMessageOptions = z.infer<
  typeof schemas.messages.SendTemplateMessageBodySchema
>;

export type SendTemplateMessageResponse = z.infer<
  typeof schemas.messages.SendMessageResponseSchema
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
      schema: schemas.messages.SendMessageResponseSchema,
    },
  });

  return output;
}

export type SendTextMessageOptions = z.infer<
  typeof schemas.messages.SendTextMessageBodySchema
>;

export type SendTextMessageResponse = z.infer<
  typeof schemas.messages.SendMessageResponseSchema
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
      schema: schemas.messages.SendMessageResponseSchema,
    },
  });

  return output;
}

export type SendReactionMessageOptions = z.infer<
  typeof schemas.messages.SendReactionMessageBodySchema
>;

export type SendReactionMessageResponse = z.infer<
  typeof schemas.messages.SendMessageResponseSchema
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
      schema: schemas.messages.SendMessageResponseSchema,
    },
  });

  return output;
}

export type SendImageMessageOptions = z.infer<
  typeof schemas.messages.SendImageMessageBodySchema
>;

export type SendImageMessageResponse = z.infer<
  typeof schemas.messages.SendMessageResponseSchema
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
      schema: schemas.messages.SendMessageResponseSchema,
    },
  });

  return output;
}

export type SendLocationMessageOptions = z.infer<
  typeof schemas.messages.SendLocationMessageBodySchema
>;

export type SendLocationMessageResponse = z.infer<
  typeof schemas.messages.SendMessageResponseSchema
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
      schema: schemas.messages.SendMessageResponseSchema,
    },
  });

  return output;
}

import { getTriggerRun } from "@trigger.dev/sdk/index";
import { z } from "zod";
import * as events from "./events";
import { schemas } from "./internal";
export { events };

export type SendTemplateMessageOptions = z.infer<
  typeof schemas.messages.SendTemplateMessageBodySchema
>;

export type SendTemplateMessageResponse = z.infer<
  typeof schemas.messages.SendTemplateMessageResponseSchema
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
      schema: schemas.messages.SendTemplateMessageResponseSchema,
    },
  });

  return output;
}

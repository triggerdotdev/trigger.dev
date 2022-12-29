import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import { slack } from "internal-integrations";

export type PostMessageOptions = z.infer<
  typeof slack.schemas.PostMessageBodySchema
>;

export type PostMessageResponse = z.infer<
  typeof slack.schemas.PostMessageResponseSchema
>;

export async function postMessage(
  options: PostMessageOptions
): Promise<PostMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call postMessage outside of a trigger run");
  }

  const response = await run.performRequest({
    service: "slack",
    endpoint: "chat.postMessage",
    params: options,
    response: {
      schema: slack.schemas.PostMessageResponseSchema,
    },
  });

  return response.body;
}

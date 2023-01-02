import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import { slack } from "internal-integrations";

export type PostMessageOptions = z.infer<
  typeof slack.schemas.PostMessageBodySchema
>;

export type PostMessageResponse = z.infer<
  typeof slack.schemas.PostMessageSuccessResponseSchema
>;

export async function postMessage(
  options: PostMessageOptions
): Promise<PostMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call postMessage outside of a trigger run");
  }

  const output = await run.performRequest({
    service: "slack",
    endpoint: "chat.postMessage",
    params: options,
    response: {
      schema: slack.schemas.PostMessageSuccessResponseSchema,
    },
  });

  return output;
}

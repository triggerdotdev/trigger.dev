import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import { slack } from "@trigger.dev/providers";

export type PostMessageOptions = z.infer<
  typeof slack.schemas.PostMessageOptionsSchema
>;

export type PostMessageResponse = z.infer<
  typeof slack.schemas.PostMessageSuccessResponseSchema
>;

export async function postMessage(
  key: string,
  options: PostMessageOptions
): Promise<PostMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call postMessage outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "chat.postMessage",
    params: options,
    response: {
      schema: slack.schemas.PostMessageSuccessResponseSchema,
    },
  });

  return output;
}

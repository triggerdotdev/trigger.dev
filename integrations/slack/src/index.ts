import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import * as events from "./events";
import * as schemas from "./schemas";

export { events };

export type PostMessageOptions = z.infer<
  typeof schemas.PostMessageOptionsSchema
>;

export type PostMessageResponse = z.infer<
  typeof schemas.PostMessageSuccessResponseSchema
>;

export async function postMessage(
  key: string,
  message: PostMessageOptions
): Promise<PostMessageResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call postMessage outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "chat.postMessage",
    params: message,
    response: {
      schema: schemas.PostMessageSuccessResponseSchema,
    },
  });

  return output;
}

export type PostMessageResponseOptions = z.infer<
  typeof schemas.PostMessageResponseOptionsSchema
>;

export type PostMessageResponseResponse = z.infer<
  typeof schemas.PostMessageResponseSuccessResponseSchema
>;

export async function postMessageResponse(
  key: string,
  responseUrl: string,
  message: PostMessageResponseOptions
): Promise<PostMessageResponseResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call postMessageResponse outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "chat.postMessageResponse",
    params: { message, responseUrl },
    response: {
      schema: schemas.PostMessageResponseSuccessResponseSchema,
    },
  });

  return output;
}

export type AddReactionOptions = z.infer<
  typeof schemas.AddReactionOptionsSchema
>;

export type AddReactionResponse = z.infer<
  typeof schemas.AddReactionSuccessResponseSchema
>;

export async function addReaction(
  key: string,
  options: AddReactionOptions
): Promise<AddReactionResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call addReaction outside of a trigger run");
  }

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "reactions.add",
    params: options,
    response: {
      schema: schemas.AddReactionSuccessResponseSchema,
    },
  });

  return output;
}

import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import * as events from "./events";
import * as schemas from "./schemas";
import zodToJsonSchema from "zod-to-json-schema";

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

export type OpenViewResponse = z.infer<
  typeof schemas.OpenViewSuccessResponseSchema
>;

export type OpenViewOptions = z.infer<typeof schemas.ModalSchema>;

export type OpenViewInteractionOptions = {
  onSubmit?: "clear" | "close" | "none";
  validationSchema?: z.ZodObject<any, any>;
};

export async function openView(
  key: string,
  triggerId: string,
  view: OpenViewOptions,
  options?: OpenViewInteractionOptions
): Promise<OpenViewResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call openView outside of a trigger run");
  }

  view.private_metadata = decoratePrivateMetadata(
    run.id,
    view.private_metadata,
    options
  );

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "views.open",
    params: { trigger_id: triggerId, view },
    response: {
      schema: schemas.OpenViewSuccessResponseSchema,
    },
  });

  return output;
}

// Cannot be called when the trigger is a viewSubmissionInteraction event, only a blockActionInteraction event
export async function updateView(
  key: string,
  view: { id: string; hash: string; external_id?: string },
  updatedView: OpenViewOptions,
  options?: OpenViewInteractionOptions
): Promise<OpenViewResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call updateView outside of a trigger run");
  }

  updatedView.private_metadata = decoratePrivateMetadata(
    run.id,
    updatedView.private_metadata,
    options
  );

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "views.update",
    params: {
      hash: view.hash,
      view_id: view.id,
      external_id: view.id ? undefined : view.external_id,
      view: updatedView,
    },
    response: {
      schema: schemas.OpenViewSuccessResponseSchema,
    },
  });

  return output;
}

// Cannot be called when the trigger is a viewSubmissionInteraction event, only a blockActionInteraction event
export async function pushView(
  key: string,
  triggerId: string,
  view: OpenViewOptions,
  options?: OpenViewInteractionOptions
): Promise<OpenViewResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call pushView outside of a trigger run");
  }

  view.private_metadata = decoratePrivateMetadata(
    run.id,
    view.private_metadata,
    options
  );

  const output = await run.performRequest(key, {
    service: "slack",
    endpoint: "views.push",
    params: { trigger_id: triggerId, view },
    response: {
      schema: schemas.OpenViewSuccessResponseSchema,
    },
  });

  return output;
}

function decoratePrivateMetadata(
  runId: string,
  existingMetadata?: string,
  options?: OpenViewInteractionOptions
): string {
  if (!existingMetadata) {
    existingMetadata = "{}";
  }

  const onSubmit = options?.onSubmit;
  const validationSchema = options?.validationSchema;

  const privateMetadata = JSON.parse(existingMetadata);

  privateMetadata.__trigger = {
    runId: runId,
    onSubmit: typeof onSubmit === "undefined" ? "none" : onSubmit,
    validationSchema: validationSchema
      ? zodToJsonSchema(validationSchema.passthrough(), { errorMessages: true })
      : null,
  };

  return JSON.stringify(privateMetadata);
}

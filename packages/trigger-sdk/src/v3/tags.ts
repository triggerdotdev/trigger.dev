import type { ApiRequestOptions, RunTags } from "@trigger.dev/core/v3";
import {
  ApiPromise,
  UnprocessableEntityError,
  accessoryAttributes,
  apiClientManager,
  logger,
  mergeRequestOptions,
  taskContext,
} from "@trigger.dev/core/v3";
import { apiClientMissingError } from "./shared";
import { tracer } from "./tracer";

export const tags = {
  add: addTags,
};

async function addTags(tags: RunTags, requestOptions?: ApiRequestOptions) {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  const run = taskContext.ctx?.run;
  if (!run) {
    throw new Error(
      "Can't set tags outside of a run. You can trigger a task and set tags in the options."
    );
  }

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "tags.set()",
      icon: "tag",
      attributes: {
        ...accessoryAttributes({
          items: [
            {
              text: tags.join(", "),
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  try {
    await apiClient.setTags(run.id, { tags }, $requestOptions);
  } catch (error) {
    if (error instanceof UnprocessableEntityError) {
      logger.error(error.message, {
        existingTags: run.tags,
        newTags: tags,
      });
      return;
    }

    logger.error("Failed to set tags", { error });

    throw error;
  }
}

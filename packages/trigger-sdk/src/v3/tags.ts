import type { ApiRequestOptions, RunTags } from "@trigger.dev/core/v3";
import {
  UnprocessableEntityError,
  accessoryAttributes,
  apiClientManager,
  logger,
  mergeRequestOptions,
  taskContext,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

/**
 * Provides access to the tags of the current run.
 * @namespace
 * @property {Function} add - Add one or more tags to the current run.
 * @property {Function} delete - Remove one or more tags from the current run.
 */
export const tags = {
  add: addTags,
  delete: deleteTags,
};

/**
 * Add one or more tags to the current run. Existing tags are kept, and tags the run
 * already has are ignored.
 *
 * A run can have at most 10 tags. If the call would take the run over that limit an
 * error is logged and the new tags are not added.
 *
 * @param {RunTags} tags - A single tag, or an array of tags, to add to the run.
 * @param {ApiRequestOptions} [requestOptions] - Optional request options.
 * @returns {Promise<void>} Resolves once the tags have been added.
 *
 * @example
 * import { tags, task } from "@trigger.dev/sdk";
 *
 * export const myTask = task({
 *   id: "my-task",
 *   run: async (payload: { userId: string }) => {
 *     await tags.add(`user_${payload.userId}`);
 *     await tags.add(["product_1234567", "org_abcdefg"]);
 *   },
 * });
 */
async function addTags(tags: RunTags, requestOptions?: ApiRequestOptions) {
  const apiClient = apiClientManager.clientOrThrow();

  const run = taskContext.ctx?.run;
  if (!run) {
    throw new Error(
      "Can't set tags outside of a run. You can trigger a task and set tags in the options."
    );
  }

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "tags.add()",
      icon: "tag",
      attributes: {
        ...accessoryAttributes({
          items: [
            {
              text: typeof tags === "string" ? tags : tags.join(", "),
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
    await apiClient.addTags(run.id, { tags }, $requestOptions);
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

/**
 * Remove one or more tags from the current run. Only this run is affected — the tag
 * remains on any other run that has it, and stays available for filtering.
 *
 * Removing a tag the run doesn't have is a no-op, so it's safe to call this without
 * checking the run's current tags first.
 *
 * @param {RunTags} tags - A single tag, or an array of tags, to remove from the run.
 * @param {ApiRequestOptions} [requestOptions] - Optional request options.
 * @returns {Promise<void>} Resolves once the tags have been removed.
 *
 * @example
 * import { tags, task } from "@trigger.dev/sdk";
 *
 * export const myTask = task({
 *   id: "my-task",
 *   run: async () => {
 *     await tags.add("status_processing");
 *     // ...
 *     await tags.delete("status_processing");
 *     await tags.add("status_done");
 *   },
 * });
 */
async function deleteTags(tags: RunTags, requestOptions?: ApiRequestOptions): Promise<void> {
  const apiClient = apiClientManager.clientOrThrow();

  const run = taskContext.ctx?.run;
  if (!run) {
    throw new Error("Can't delete tags outside of a run.");
  }

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "tags.delete()",
      icon: "tag",
      attributes: {
        ...accessoryAttributes({
          items: [
            {
              text: typeof tags === "string" ? tags : tags.join(", "),
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
    await apiClient.removeTags(run.id, { tags }, $requestOptions);
  } catch (error) {
    logger.error("Failed to delete tags", { error });

    throw error;
  }
}

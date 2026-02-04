import {
  accessoryAttributes,
  apiClientManager,
  ApiPromise,
  ApiRequestOptions,
  mergeRequestOptions,
  RetrieveBatchResponse,
  RetrieveBatchV2Response,
} from "@trigger.dev/core/v3";
import {
  batchTriggerAndWaitTasks,
  batchTriggerById,
  batchTriggerByIdAndWait,
  batchTriggerTasks,
} from "./shared.js";
import { tracer } from "./tracer.js";

export const batch = {
  trigger: batchTriggerById,
  triggerAndWait: batchTriggerByIdAndWait,
  triggerByTask: batchTriggerTasks,
  triggerByTaskAndWait: batchTriggerAndWaitTasks,
  retrieve: retrieveBatch,
};

/**
 * Retrieves details about a specific batch by its ID.
 *
 * @param {string} batchId - The unique identifier of the batch to retrieve
 * @param {ApiRequestOptions} [requestOptions] - Optional API request configuration options
 * @returns {ApiPromise<RetrieveBatchResponse>} A promise that resolves with the batch details
 *
 * @example
 * // First trigger a batch
 * const response = await batch.trigger([
 *   { id: "simple-task", payload: { message: "Hello, World!" } }
 * ]);
 *
 * // Then retrieve the batch details
 * const batchDetails = await batch.retrieve(response.batchId);
 * console.log("batch", batchDetails);
 */
function retrieveBatch(
  batchId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveBatchV2Response> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "batch.retrieve()",
      icon: "batch",
      attributes: {
        batchId: batchId,
        ...accessoryAttributes({
          items: [
            {
              text: batchId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.retrieveBatch(batchId, $requestOptions);
}

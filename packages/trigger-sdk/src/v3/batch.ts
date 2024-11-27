import {
  accessoryAttributes,
  apiClientManager,
  ApiPromise,
  ApiRequestOptions,
  mergeRequestOptions,
  RetrieveBatchResponse,
} from "@trigger.dev/core/v3";
import {
  batchTriggerById,
  batchTriggerByIdAndWait,
  batchTriggerTasks,
  batchTriggerAndWaitTasks,
} from "./shared.js";
import { tracer } from "./tracer.js";

export const batch = {
  trigger: batchTriggerById,
  triggerAndWait: batchTriggerByIdAndWait,
  triggerByTask: batchTriggerTasks,
  triggerByTaskAndWait: batchTriggerAndWaitTasks,
  retrieve: retrieveBatch,
};

function retrieveBatch(
  batchId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveBatchResponse> {
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

import {
  apiClientManager,
  ApiRequestOptions,
  ListQueueOptions,
  mergeRequestOptions,
  OffsetLimitPagePromise,
  QueueItem,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

/**
 * Lists schedules
 * @param options - The list options
 * @param options.page - The page number
 * @param options.perPage - The number of schedules per page
 * @returns The list of schedules
 */
export function list(
  options?: ListQueueOptions,
  requestOptions?: ApiRequestOptions
): OffsetLimitPagePromise<typeof QueueItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "queues.list()",
      icon: "queue",
    },
    requestOptions
  );

  return apiClient.listQueues(options, $requestOptions);
}

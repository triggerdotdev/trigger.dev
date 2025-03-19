import {
  accessoryAttributes,
  apiClientManager,
  ApiPromise,
  ApiRequestOptions,
  ListQueueOptions,
  mergeRequestOptions,
  OffsetLimitPagePromise,
  QueueItem,
  RetrieveQueueParam,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";

/**
 * Lists queues
 * @param options - The list options
 * @param options.page - The page number
 * @param options.perPage - The number of queues per page
 * @returns The list of queues
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

/**
 * When retrieving a queue you can either use the queue id,
 * or the type and name.
 *
 * @example
 *
 * ```ts
 * // Use a queue id (they start with queue_
 * const q1 = await queues.retrieve("queue_12345");
 *
 * // Or use the type and name
 * // The default queue for your "my-task-id"
 * const q2 = await queues.retrieve({ type: "task", name: "my-task-id"});
 *
 * // The custom queue you defined in your code
 * const q3 = await queues.retrieve({ type: "custom", name: "my-custom-queue" });
 * ```
 * @param queue - The ID of the queue to retrieve, or the type and name
 * @returns The retrieved queue
 */
export function retrieve(
  queue: RetrieveQueueParam,
  requestOptions?: ApiRequestOptions
): ApiPromise<QueueItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "queues.retrieve()",
      icon: "queue",
      attributes: {
        queue: typeof queue === "string" ? queue : queue.name,
        ...accessoryAttributes({
          items: [
            {
              text: typeof queue === "string" ? queue : queue.name,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.retrieveQueue(queue, $requestOptions);
}

import {
  ApiPromise,
  ApiRequestOptions,
  DeletedScheduleObject,
  InitOutput,
  OffsetLimitPagePromise,
  ScheduleObject,
  TimezonesResult,
  accessoryAttributes,
  apiClientManager,
  mergeRequestOptions,
  resourceCatalog,
} from "@trigger.dev/core/v3";
import { zodfetch } from "@trigger.dev/core/v3/zodfetch";
import { Task, TaskOptions, createTask } from "../shared.js";
import * as SchedulesAPI from "./api.js";
import { tracer } from "../tracer.js";

export type ScheduleOptions<
  TIdentifier extends string,
  TOutput,
  TInitOutput extends InitOutput,
> = TaskOptions<TIdentifier, SchedulesAPI.ScheduledTaskPayload, TOutput, TInitOutput> & {
  /** You can optionally specify a CRON schedule on your task. You can also dynamically add a schedule in the dashboard or using the SDK functions.
   *
   * 1. Pass a CRON pattern string
   * ```ts
   * "0 0 * * *"
   * ```
   *
   * 2. Or an object with a pattern and an optional timezone (default is "UTC")
   * ```ts
   * {
   *   pattern: "0 0 * * *",
   *   timezone: "America/Los_Angeles"
   * }
   * ```
   *
   * @link https://trigger.dev/docs/v3/tasks-scheduled
   */
  cron?:
    | string
    | {
        pattern: string;
        timezone?: string;
      };
};

export function task<TIdentifier extends string, TOutput, TInitOutput extends InitOutput>(
  params: ScheduleOptions<TIdentifier, TOutput, TInitOutput>
): Task<TIdentifier, SchedulesAPI.ScheduledTaskPayload, TOutput> {
  const task = createTask(params);

  const cron = params.cron
    ? typeof params.cron === "string"
      ? params.cron
      : params.cron.pattern
    : undefined;
  const timezone =
    (params.cron && typeof params.cron !== "string" ? params.cron.timezone : "UTC") ?? "UTC";

  resourceCatalog.updateTaskMetadata(task.id, {
    triggerSource: "schedule",
    schedule: cron
      ? {
          cron: cron,
          timezone,
        }
      : undefined,
  });

  return task;
}

/**
 * Creates a new schedule
 * @param options
 * @param options.task - The identifier of the task to be scheduled (Must already exist and be a scheduled task)
 * @param options.cron - The cron expression for the schedule (e.g. `0 0 * * *`)
 * @param options.timezone - An optional timezone for the schedule in the IANA format (e.g. `America/Los_Angeles`). Defaults to "UTC".
 * @param options.externalId - An optional external identifier for the schedule
 * @param options.deduplicationKey - An optional deduplication key for the schedule
 * @returns The created schedule
 */
export function create(
  options: SchedulesAPI.CreateScheduleOptions,
  requestOptions?: ApiRequestOptions
): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "schedules.create()",
      icon: "clock",
      attributes: {
        ...accessoryAttributes({
          items: [
            {
              text: options.cron,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.createSchedule(options, $requestOptions);
}

/**
 * Retrieves a schedule
 * @param scheduleId - The ID of the schedule to retrieve
 * @returns The retrieved schedule
 */
export function retrieve(
  scheduleId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "schedules.retrieve()",
      icon: "clock",
      attributes: {
        scheduleId,
        ...accessoryAttributes({
          items: [
            {
              text: scheduleId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.retrieveSchedule(scheduleId, $requestOptions);
}

/**
 * Updates a schedule
 * @param scheduleId - The ID of the schedule to update
 * @param options - The updated schedule options
 * @param options.task - The identifier of the task to be scheduled (Must already exist and be a scheduled task)
 * @param options.cron - The cron expression for the schedule (e.g. `0 0 * * *`)
 * @param options.timezone - An optional timezone for the schedule in the IANA format (e.g. `America/Los_Angeles`). Defaults to "UTC".
 * @param options.externalId - An optional external identifier for the schedule
 * @returns The updated schedule
 */
export function update(
  scheduleId: string,
  options: SchedulesAPI.UpdateScheduleOptions,
  requestOptions?: ApiRequestOptions
): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "schedules.update()",
      icon: "clock",
      attributes: {
        scheduleId,
        ...accessoryAttributes({
          items: [
            {
              text: scheduleId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.updateSchedule(scheduleId, options, $requestOptions);
}

/**
 * Deletes a schedule
 * @param scheduleId - The ID of the schedule to delete
 */
export function del(
  scheduleId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<DeletedScheduleObject> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "schedules.delete()",
      icon: "clock",
      attributes: {
        scheduleId,
        ...accessoryAttributes({
          items: [
            {
              text: scheduleId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.deleteSchedule(scheduleId, $requestOptions);
}

/**
 * Deactivates a schedule
 * @param scheduleId - The ID of the schedule to deactivate
 */
export function deactivate(
  scheduleId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "schedules.deactivate()",
      icon: "clock",
      attributes: {
        scheduleId,
        ...accessoryAttributes({
          items: [
            {
              text: scheduleId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.deactivateSchedule(scheduleId, $requestOptions);
}

/**
 * Activates a schedule
 * @param scheduleId - The ID of the schedule to activate
 */
export function activate(
  scheduleId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "schedules.activate()",
      icon: "clock",
      attributes: {
        scheduleId,
        ...accessoryAttributes({
          items: [
            {
              text: scheduleId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.activateSchedule(scheduleId, $requestOptions);
}

/**
 * Lists schedules
 * @param options - The list options
 * @param options.page - The page number
 * @param options.perPage - The number of schedules per page
 * @returns The list of schedules
 */
export function list(
  options?: SchedulesAPI.ListScheduleOptions,
  requestOptions?: ApiRequestOptions
): OffsetLimitPagePromise<typeof ScheduleObject> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "schedules.list()",
      icon: "clock",
    },
    requestOptions
  );

  return apiClient.listSchedules(options, $requestOptions);
}

/**
 * Lists the possible timezones we support
 * @param excludeUtc - By default "UTC" is included and is first. If true, "UTC" will be excluded.
 */
export function timezones(options?: { excludeUtc?: boolean }) {
  const baseUrl = apiClientManager.baseURL;

  return zodfetch(
    TimezonesResult,
    `${baseUrl}/api/v1/timezones${options?.excludeUtc === true ? "?excludeUtc=true" : ""}`,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

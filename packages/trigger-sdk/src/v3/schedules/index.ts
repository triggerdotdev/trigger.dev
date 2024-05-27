import {
  ApiPromise,
  DeletedScheduleObject,
  InitOutput,
  ListSchedulesResult,
  ScheduleObject,
  apiClientManager,
  taskCatalog,
} from "@trigger.dev/core/v3";
import { Task, TaskOptions, apiClientMissingError, createTask } from "../shared";
import * as SchedulesAPI from "./api";

export function task<TOutput, TInitOutput extends InitOutput>(
  params: TaskOptions<SchedulesAPI.ScheduledTaskPayload, TOutput, TInitOutput>
): Task<SchedulesAPI.ScheduledTaskPayload, TOutput> {
  const task = createTask(params);

  taskCatalog.updateTaskMetadata(task.id, {
    triggerSource: "schedule",
  });

  return task;
}

/**
 * Creates a new schedule
 * @param options
 * @param options.task - The identifier of the task to be scheduled (Must already exist and be a scheduled task)
 * @param options.cron - The cron expression for the schedule (e.g. `0 0 * * *`)
 * @param options.externalId - An optional external identifier for the schedule
 * @param options.deduplicationKey - An optional deduplication key for the schedule
 * @returns The created schedule
 */
export function create(options: SchedulesAPI.CreateScheduleOptions): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.createSchedule(options);
}

/**
 * Retrieves a schedule
 * @param scheduleId - The ID of the schedule to retrieve
 * @returns The retrieved schedule
 */
export function retrieve(scheduleId: string): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.retrieveSchedule(scheduleId);
}

/**
 * Updates a schedule
 * @param scheduleId - The ID of the schedule to update
 * @param options - The updated schedule options
 * @param options.task - The identifier of the task to be scheduled (Must already exist and be a scheduled task)
 * @param options.cron - The cron expression for the schedule (e.g. `0 0 * * *`)
 * @param options.externalId - An optional external identifier for the schedule
 * @returns The updated schedule
 */
export function update(
  scheduleId: string,
  options: SchedulesAPI.UpdateScheduleOptions
): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.updateSchedule(scheduleId, options);
}

/**
 * Deletes a schedule
 * @param scheduleId - The ID of the schedule to delete
 */
export function del(scheduleId: string): ApiPromise<DeletedScheduleObject> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.deleteSchedule(scheduleId);
}

/**
 * Deactivates a schedule
 * @param scheduleId - The ID of the schedule to deactivate
 */
export function deactivate(scheduleId: string): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.deactivateSchedule(scheduleId);
}

/**
 * Activates a schedule
 * @param scheduleId - The ID of the schedule to activate
 */
export function activate(scheduleId: string): ApiPromise<ScheduleObject> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.activateSchedule(scheduleId);
}

/**
 * Lists schedules
 * @param options - The list options
 * @param options.page - The page number
 * @param options.perPage - The number of schedules per page
 * @returns The list of schedules
 */
export function list(options?: SchedulesAPI.ListScheduleOptions) {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return apiClient.listSchedules(options);
}

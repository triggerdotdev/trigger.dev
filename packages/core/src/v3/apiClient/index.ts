import { context, propagation } from "@opentelemetry/api";
import { version } from "../../../package.json";
import {
  BatchTaskRunExecutionResult,
  BatchTriggerTaskRequestBody,
  BatchTriggerTaskResponse,
  CanceledRunResponse,
  CreateEnvironmentVariableRequestBody,
  CreateScheduleOptions,
  CreateUploadPayloadUrlResponseBody,
  DeletedScheduleObject,
  EnvironmentVariableResponseBody,
  EnvironmentVariableValue,
  EnvironmentVariables,
  ListRunResponseItem,
  ListScheduleOptions,
  ReplayRunResponse,
  RescheduleRunRequestBody,
  RetrieveRunResponse,
  ScheduleObject,
  TaskRunExecutionResult,
  TriggerTaskRequestBody,
  TriggerTaskResponse,
  UpdateEnvironmentVariableRequestBody,
  UpdateScheduleOptions,
} from "../schemas";
import { taskContext } from "../task-context-api";
import {
  ApiRequestOptions,
  CursorPagePromise,
  ZodFetchOptions,
  isRequestOptions,
  zodfetch,
  zodfetchCursorPage,
  zodfetchOffsetLimitPage,
} from "./core";
import { ApiError } from "./errors";
import {
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  ListProjectRunsQueryParams,
  ListRunsQueryParams,
  UpdateEnvironmentVariableParams,
} from "./types";

export type {
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  UpdateEnvironmentVariableParams,
};

export type TriggerOptions = {
  spanParentAsLink?: boolean;
};

const DEFAULT_ZOD_FETCH_OPTIONS: ZodFetchOptions = {
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: false,
  },
};

export type { ApiRequestOptions };
export { isRequestOptions };

/**
 * Trigger.dev v3 API client
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly defaultRequestOptions: ZodFetchOptions;

  constructor(
    baseUrl: string,
    private readonly accessToken: string,
    requestOptions: ApiRequestOptions = {}
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultRequestOptions = mergeRequestOptions(DEFAULT_ZOD_FETCH_OPTIONS, requestOptions);
  }

  async getRunResult(
    runId: string,
    requestOptions?: ZodFetchOptions
  ): Promise<TaskRunExecutionResult | undefined> {
    try {
      return await zodfetch(
        TaskRunExecutionResult,
        `${this.baseUrl}/api/v1/runs/${runId}/result`,
        {
          method: "GET",
          headers: this.#getHeaders(false),
        },
        mergeRequestOptions(this.defaultRequestOptions, requestOptions)
      );
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 404) {
          return undefined;
        }
      }

      throw error;
    }
  }

  async getBatchResults(
    batchId: string,
    requestOptions?: ZodFetchOptions
  ): Promise<BatchTaskRunExecutionResult | undefined> {
    return await zodfetch(
      BatchTaskRunExecutionResult,
      `${this.baseUrl}/api/v1/batches/${batchId}/results`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  triggerTask(
    taskId: string,
    body: TriggerTaskRequestBody,
    options?: TriggerOptions,
    requestOptions?: ZodFetchOptions
  ) {
    const encodedTaskId = encodeURIComponent(taskId);

    return zodfetch(
      TriggerTaskResponse,
      `${this.baseUrl}/api/v1/tasks/${encodedTaskId}/trigger`,
      {
        method: "POST",
        headers: this.#getHeaders(options?.spanParentAsLink ?? false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  batchTriggerTask(
    taskId: string,
    body: BatchTriggerTaskRequestBody,
    options?: TriggerOptions,
    requestOptions?: ZodFetchOptions
  ) {
    const encodedTaskId = encodeURIComponent(taskId);

    return zodfetch(
      BatchTriggerTaskResponse,
      `${this.baseUrl}/api/v1/tasks/${encodedTaskId}/batch`,
      {
        method: "POST",
        headers: this.#getHeaders(options?.spanParentAsLink ?? false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  createUploadPayloadUrl(filename: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/packets/${filename}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  getPayloadUrl(filename: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/packets/${filename}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveRunResponse,
      `${this.baseUrl}/api/v3/runs/${runId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listRuns(
    query?: ListRunsQueryParams,
    requestOptions?: ZodFetchOptions
  ): CursorPagePromise<typeof ListRunResponseItem> {
    const searchParams = createSearchQueryForListRuns(query);

    return zodfetchCursorPage(
      ListRunResponseItem,
      `${this.baseUrl}/api/v1/runs`,
      {
        query: searchParams,
        limit: query?.limit,
        after: query?.after,
        before: query?.before,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listProjectRuns(
    projectRef: string,
    query?: ListProjectRunsQueryParams,
    requestOptions?: ZodFetchOptions
  ): CursorPagePromise<typeof ListRunResponseItem> {
    const searchParams = createSearchQueryForListRuns(query);

    if (query?.env) {
      searchParams.append(
        "filter[env]",
        Array.isArray(query.env) ? query.env.join(",") : query.env
      );
    }

    return zodfetchCursorPage(
      ListRunResponseItem,
      `${this.baseUrl}/api/v1/projects/${projectRef}/runs`,
      {
        query: searchParams,
        limit: query?.limit,
        after: query?.after,
        before: query?.before,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  replayRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ReplayRunResponse,
      `${this.baseUrl}/api/v1/runs/${runId}/replay`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  cancelRun(runId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      CanceledRunResponse,
      `${this.baseUrl}/api/v2/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  rescheduleRun(runId: string, body: RescheduleRunRequestBody, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      RetrieveRunResponse,
      `${this.baseUrl}/api/v1/runs/${runId}/reschedule`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  createSchedule(options: CreateScheduleOptions, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(options),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listSchedules(options?: ListScheduleOptions, requestOptions?: ZodFetchOptions) {
    const searchParams = new URLSearchParams();

    if (options?.page) {
      searchParams.append("page", options.page.toString());
    }

    if (options?.perPage) {
      searchParams.append("perPage", options.perPage.toString());
    }

    return zodfetchOffsetLimitPage(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules`,
      {
        page: options?.page,
        limit: options?.perPage,
      },
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  updateSchedule(
    scheduleId: string,
    options: UpdateScheduleOptions,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
        body: JSON.stringify(options),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  deactivateSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}/deactivate`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  activateSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      ScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}/activate`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  deleteSchedule(scheduleId: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      DeletedScheduleObject,
      `${this.baseUrl}/api/v1/schedules/${scheduleId}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  listEnvVars(projectRef: string, slug: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      EnvironmentVariables,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  importEnvVars(
    projectRef: string,
    slug: string,
    body: ImportEnvironmentVariablesParams,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/import`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  retrieveEnvVar(projectRef: string, slug: string, key: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      EnvironmentVariableValue,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  createEnvVar(
    projectRef: string,
    slug: string,
    body: CreateEnvironmentVariableRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  updateEnvVar(
    projectRef: string,
    slug: string,
    key: string,
    body: UpdateEnvironmentVariableRequestBody,
    requestOptions?: ZodFetchOptions
  ) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  deleteEnvVar(projectRef: string, slug: string, key: string, requestOptions?: ZodFetchOptions) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false),
      },
      mergeRequestOptions(this.defaultRequestOptions, requestOptions)
    );
  }

  #getHeaders(spanParentAsLink: boolean) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      "trigger-version": version,
    };

    // Only inject the context if we are inside a task
    if (taskContext.isInsideTask) {
      headers["x-trigger-worker"] = "true";
      propagation.inject(context.active(), headers);

      if (spanParentAsLink) {
        headers["x-trigger-span-parent-as-link"] = "1";
      }
    }

    return headers;
  }
}

function createSearchQueryForListRuns(query?: ListRunsQueryParams): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (query) {
    if (query.status) {
      searchParams.append(
        "filter[status]",
        Array.isArray(query.status) ? query.status.join(",") : query.status
      );
    }

    if (query.taskIdentifier) {
      searchParams.append(
        "filter[taskIdentifier]",
        Array.isArray(query.taskIdentifier) ? query.taskIdentifier.join(",") : query.taskIdentifier
      );
    }

    if (query.version) {
      searchParams.append(
        "filter[version]",
        Array.isArray(query.version) ? query.version.join(",") : query.version
      );
    }

    if (query.bulkAction) {
      searchParams.append("filter[bulkAction]", query.bulkAction);
    }

    if (query.schedule) {
      searchParams.append("filter[schedule]", query.schedule);
    }

    if (typeof query.isTest === "boolean") {
      searchParams.append("filter[isTest]", String(query.isTest));
    }

    if (query.from) {
      searchParams.append(
        "filter[createdAt][from]",
        query.from instanceof Date ? query.from.getTime().toString() : query.from.toString()
      );
    }

    if (query.to) {
      searchParams.append(
        "filter[createdAt][to]",
        query.to instanceof Date ? query.to.getTime().toString() : query.to.toString()
      );
    }

    if (query.period) {
      searchParams.append("filter[createdAt][period]", query.period);
    }
  }

  return searchParams;
}

export function mergeRequestOptions(
  defaultOptions: ZodFetchOptions,
  options?: ApiRequestOptions
): ZodFetchOptions {
  if (!options) {
    return defaultOptions;
  }

  return {
    ...defaultOptions,
    ...options,
    retry: {
      ...defaultOptions.retry,
      ...options.retry,
    },
  };
}

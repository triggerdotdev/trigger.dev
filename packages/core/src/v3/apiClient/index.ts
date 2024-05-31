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
  ListSchedulesResult,
  ReplayRunResponse,
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
  CursorPagePromise,
  ZodFetchOptions,
  isRecordLike,
  zodfetch,
  zodfetchCursorPage,
  zodfetchOffsetLimitPage,
  zodupload,
} from "./core";
import { APIError } from "./errors";
import {
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  ListProjectRunsQueryParams,
  ListRunsQueryParams,
  UpdateEnvironmentVariableParams,
} from "./types";
import { URLSearchParams } from "url";

export type {
  CreateEnvironmentVariableParams,
  ImportEnvironmentVariablesParams,
  UpdateEnvironmentVariableParams,
};

export type TriggerOptions = {
  spanParentAsLink?: boolean;
};

const zodFetchOptions: ZodFetchOptions = {
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: false,
  },
};

/**
 * Trigger.dev v3 API client
 */
export class ApiClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly accessToken: string
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getRunResult(runId: string): Promise<TaskRunExecutionResult | undefined> {
    try {
      return await zodfetch(
        TaskRunExecutionResult,
        `${this.baseUrl}/api/v1/runs/${runId}/result`,
        {
          method: "GET",
          headers: this.#getHeaders(false),
        },
        zodFetchOptions
      );
    } catch (error) {
      if (error instanceof APIError) {
        if (error.status === 404) {
          return undefined;
        }
      }

      throw error;
    }
  }

  async getBatchResults(batchId: string): Promise<BatchTaskRunExecutionResult | undefined> {
    return await zodfetch(
      BatchTaskRunExecutionResult,
      `${this.baseUrl}/api/v1/batches/${batchId}/results`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      zodFetchOptions
    );
  }

  triggerTask(taskId: string, body: TriggerTaskRequestBody, options?: TriggerOptions) {
    return zodfetch(
      TriggerTaskResponse,
      `${this.baseUrl}/api/v1/tasks/${taskId}/trigger`,
      {
        method: "POST",
        headers: this.#getHeaders(options?.spanParentAsLink ?? false),
        body: JSON.stringify(body),
      },
      zodFetchOptions
    );
  }

  batchTriggerTask(taskId: string, body: BatchTriggerTaskRequestBody, options?: TriggerOptions) {
    return zodfetch(
      BatchTriggerTaskResponse,
      `${this.baseUrl}/api/v1/tasks/${taskId}/batch`,
      {
        method: "POST",
        headers: this.#getHeaders(options?.spanParentAsLink ?? false),
        body: JSON.stringify(body),
      },
      zodFetchOptions
    );
  }

  createUploadPayloadUrl(filename: string) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/packets/${filename}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
      },
      zodFetchOptions
    );
  }

  getPayloadUrl(filename: string) {
    return zodfetch(
      CreateUploadPayloadUrlResponseBody,
      `${this.baseUrl}/api/v1/packets/${filename}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      zodFetchOptions
    );
  }

  retrieveRun(runId: string) {
    return zodfetch(
      RetrieveRunResponse,
      `${this.baseUrl}/api/v3/runs/${runId}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      },
      zodFetchOptions
    );
  }

  listRuns(query?: ListRunsQueryParams): CursorPagePromise<typeof ListRunResponseItem> {
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
      zodFetchOptions
    );
  }

  listProjectRuns(
    projectRef: string,
    query?: ListProjectRunsQueryParams
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
      zodFetchOptions
    );
  }

  replayRun(runId: string) {
    return zodfetch(
      ReplayRunResponse,
      `${this.baseUrl}/api/v1/runs/${runId}/replay`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      zodFetchOptions
    );
  }

  cancelRun(runId: string) {
    return zodfetch(
      CanceledRunResponse,
      `${this.baseUrl}/api/v2/runs/${runId}/cancel`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
      },
      zodFetchOptions
    );
  }

  createSchedule(options: CreateScheduleOptions) {
    return zodfetch(ScheduleObject, `${this.baseUrl}/api/v1/schedules`, {
      method: "POST",
      headers: this.#getHeaders(false),
      body: JSON.stringify(options),
    });
  }

  listSchedules(options?: ListScheduleOptions) {
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
      }
    );
  }

  retrieveSchedule(scheduleId: string) {
    return zodfetch(ScheduleObject, `${this.baseUrl}/api/v1/schedules/${scheduleId}`, {
      method: "GET",
      headers: this.#getHeaders(false),
    });
  }

  updateSchedule(scheduleId: string, options: UpdateScheduleOptions) {
    return zodfetch(ScheduleObject, `${this.baseUrl}/api/v1/schedules/${scheduleId}`, {
      method: "PUT",
      headers: this.#getHeaders(false),
      body: JSON.stringify(options),
    });
  }

  deactivateSchedule(scheduleId: string) {
    return zodfetch(ScheduleObject, `${this.baseUrl}/api/v1/schedules/${scheduleId}/deactivate`, {
      method: "POST",
      headers: this.#getHeaders(false),
    });
  }

  activateSchedule(scheduleId: string) {
    return zodfetch(ScheduleObject, `${this.baseUrl}/api/v1/schedules/${scheduleId}/activate`, {
      method: "POST",
      headers: this.#getHeaders(false),
    });
  }

  deleteSchedule(scheduleId: string) {
    return zodfetch(DeletedScheduleObject, `${this.baseUrl}/api/v1/schedules/${scheduleId}`, {
      method: "DELETE",
      headers: this.#getHeaders(false),
    });
  }

  listEnvVars(projectRef: string, slug: string) {
    return zodfetch(
      EnvironmentVariables,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      }
    );
  }

  importEnvVars(projectRef: string, slug: string, body: ImportEnvironmentVariablesParams) {
    if (isRecordLike(body.variables)) {
      return zodfetch(
        EnvironmentVariableResponseBody,
        `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/import`,
        {
          method: "POST",
          headers: this.#getHeaders(false),
          body: JSON.stringify(body),
        }
      );
    } else {
      return zodupload(
        EnvironmentVariableResponseBody,
        `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/import`,
        body,
        {
          method: "POST",
          headers: this.#getHeaders(false),
        }
      );
    }
  }

  retrieveEnvVar(projectRef: string, slug: string, key: string) {
    return zodfetch(
      EnvironmentVariableValue,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "GET",
        headers: this.#getHeaders(false),
      }
    );
  }

  createEnvVar(projectRef: string, slug: string, body: CreateEnvironmentVariableRequestBody) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}`,
      {
        method: "POST",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      }
    );
  }

  updateEnvVar(
    projectRef: string,
    slug: string,
    key: string,
    body: UpdateEnvironmentVariableRequestBody
  ) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "PUT",
        headers: this.#getHeaders(false),
        body: JSON.stringify(body),
      }
    );
  }

  deleteEnvVar(projectRef: string, slug: string, key: string) {
    return zodfetch(
      EnvironmentVariableResponseBody,
      `${this.baseUrl}/api/v1/projects/${projectRef}/envvars/${slug}/${key}`,
      {
        method: "DELETE",
        headers: this.#getHeaders(false),
      }
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

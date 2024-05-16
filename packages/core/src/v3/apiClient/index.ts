import { context, propagation } from "@opentelemetry/api";
import { ZodFetchOptions, zodfetch } from "../zodfetch";
import {
  BatchTaskRunExecutionResult,
  BatchTriggerTaskRequestBody,
  BatchTriggerTaskResponse,
  CanceledRunResponse,
  CreateScheduleOptions,
  CreateUploadPayloadUrlResponseBody,
  DeletedScheduleObject,
  ListScheduleOptions,
  ListSchedulesResult,
  ReplayRunResponse,
  RetrieveRunResponse,
  ScheduleObject,
  TaskRunExecutionResult,
  TriggerTaskRequestBody,
  TriggerTaskResponse,
  UpdateScheduleOptions,
} from "../schemas";
import { taskContext } from "../task-context-api";
import { getEnvVar } from "../utils/getEnv";
import { SafeAsyncLocalStorage } from "../utils/safeAsyncLocalStorage";
import { APIError } from "../apiErrors";
import { version } from "../../../package.json";

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

    return zodfetch(
      ListSchedulesResult,
      `${this.baseUrl}/api/v1/schedules${searchParams.size > 0 ? `?${searchParams}` : ""}`,
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

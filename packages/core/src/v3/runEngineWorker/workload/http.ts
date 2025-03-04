import { z } from "zod";
import {
  WorkloadHeartbeatRequestBody,
  WorkloadHeartbeatResponseBody,
  WorkloadRunAttemptCompleteRequestBody,
  WorkloadRunAttemptCompleteResponseBody,
  WorkloadRunAttemptStartResponseBody,
  WorkloadRunLatestSnapshotResponseBody,
  WorkloadDequeueFromVersionResponseBody,
  WorkloadRunAttemptStartRequestBody,
  WorkloadSuspendRunResponseBody,
  WorkloadContinueRunExecutionResponseBody,
  WorkloadDebugLogRequestBody,
} from "./schemas.js";
import { WorkloadClientCommonOptions } from "./types.js";
import { getDefaultWorkloadHeaders } from "./util.js";
import { ApiError, zodfetch } from "../../zodfetch.js";

type WorkloadHttpClientOptions = WorkloadClientCommonOptions;

export class WorkloadHttpClient {
  private readonly apiUrl: string;
  private readonly deploymentId: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: WorkloadHttpClientOptions) {
    this.apiUrl = opts.workerApiUrl.replace(/\/$/, "");
    this.defaultHeaders = getDefaultWorkloadHeaders(opts);
    this.deploymentId = opts.deploymentId;

    if (!this.apiUrl) {
      throw new Error("apiURL is required and needs to be a non-empty string");
    }

    if (!this.deploymentId) {
      throw new Error("deploymentId is required and needs to be a non-empty string");
    }
  }

  async heartbeatRun(runId: string, snapshotId: string, body: WorkloadHeartbeatRequestBody) {
    return wrapZodFetch(
      WorkloadHeartbeatResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/heartbeat`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  async suspendRun(runId: string, snapshotId: string) {
    return wrapZodFetch(
      WorkloadSuspendRunResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/suspend`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async continueRunExecution(runId: string, snapshotId: string) {
    return wrapZodFetch(
      WorkloadContinueRunExecutionResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/continue`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async startRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkloadRunAttemptStartRequestBody
  ) {
    return wrapZodFetch(
      WorkloadRunAttemptStartResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
        },
        body: JSON.stringify(body),
      }
    );
  }

  async completeRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkloadRunAttemptCompleteRequestBody
  ) {
    return wrapZodFetch(
      WorkloadRunAttemptCompleteResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
        },
        body: JSON.stringify(body),
      }
    );
  }

  async getRunExecutionData(runId: string) {
    return wrapZodFetch(
      WorkloadRunLatestSnapshotResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/snapshots/latest`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async sendDebugLog(runId: string, body: WorkloadDebugLogRequestBody): Promise<void> {
    try {
      const res = await wrapZodFetch(
        z.unknown(),
        `${this.apiUrl}/api/v1/workload-actions/runs/${runId}/logs/debug`,
        {
          method: "POST",
          headers: {
            ...this.defaultHeaders,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.success) {
        console.error("Failed to send debug log", res);
      }
    } catch (error) {
      console.error("Failed to send debug log", { error });
    }
  }

  async dequeue() {
    return wrapZodFetch(
      WorkloadDequeueFromVersionResponseBody,
      `${this.apiUrl}/api/v1/workload-actions/deployments/${this.deploymentId}/dequeue`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }
}

type ApiResult<TSuccessResult> =
  | { success: true; data: TSuccessResult }
  | {
      success: false;
      error: string;
    };

async function wrapZodFetch<T extends z.ZodTypeAny>(
  schema: T,
  url: string,
  requestInit?: RequestInit
): Promise<ApiResult<z.infer<T>>> {
  try {
    const response = await zodfetch(schema, url, requestInit, {
      retry: {
        minTimeoutInMs: 500,
        maxTimeoutInMs: 5000,
        maxAttempts: 5,
        factor: 2,
        randomize: false,
      },
    });

    return {
      success: true,
      data: response,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        success: false,
        error: error.message,
      };
    } else if (error instanceof Error) {
      return {
        success: false,
        error: error.message,
      };
    } else {
      return {
        success: false,
        error: String(error),
      };
    }
  }
}

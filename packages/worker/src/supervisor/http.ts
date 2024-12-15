import { z } from "zod";
import { zodfetch, ApiError } from "@trigger.dev/core/v3/zodfetch";
import {
  WorkerApiConnectRequestBody,
  WorkerApiConnectResponseBody,
  WorkerApiDequeueResponseBody,
  WorkerApiHeartbeatRequestBody,
  WorkerApiHeartbeatResponseBody,
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptCompleteResponseBody,
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiRunAttemptStartResponseBody,
  WorkerApiRunHeartbeatRequestBody,
  WorkerApiRunHeartbeatResponseBody,
  WorkerApiRunLatestSnapshotResponseBody,
  WorkerApiWaitForDurationRequestBody,
  WorkerApiWaitForDurationResponseBody,
} from "./schemas.js";
import { SupervisorClientCommonOptions } from "./types.js";
import { getDefaultWorkerHeaders } from "./util.js";

type SupervisorHttpClientOptions = SupervisorClientCommonOptions;

export class SupervisorHttpClient {
  private readonly apiUrl: string;
  private readonly workerToken: string;
  private readonly instanceName: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: SupervisorHttpClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.workerToken = opts.workerToken;
    this.instanceName = opts.instanceName;
    this.defaultHeaders = getDefaultWorkerHeaders(opts);

    if (!this.apiUrl) {
      throw new Error("apiURL is required and needs to be a non-empty string");
    }

    if (!this.workerToken) {
      throw new Error("workerToken is required and needs to be a non-empty string");
    }

    if (!this.instanceName) {
      throw new Error("instanceName is required and needs to be a non-empty string");
    }
  }

  async connect(body: WorkerApiConnectRequestBody) {
    return wrapZodFetch(
      WorkerApiConnectResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/connect`,
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

  async dequeue() {
    return wrapZodFetch(
      WorkerApiDequeueResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/dequeue`,
      {
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async dequeueFromVersion(deploymentId: string) {
    return wrapZodFetch(
      WorkerApiDequeueResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/deployments/${deploymentId}/dequeue`,
      {
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async heartbeatWorker(body: WorkerApiHeartbeatRequestBody) {
    return wrapZodFetch(
      WorkerApiHeartbeatResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/heartbeat`,
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

  async heartbeatRun(runId: string, snapshotId: string, body: WorkerApiRunHeartbeatRequestBody) {
    return wrapZodFetch(
      WorkerApiRunHeartbeatResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/heartbeat`,
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

  async startRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunAttemptStartRequestBody
  ) {
    return wrapZodFetch(
      WorkerApiRunAttemptStartResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
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
    body: WorkerApiRunAttemptCompleteRequestBody
  ) {
    return wrapZodFetch(
      WorkerApiRunAttemptCompleteResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
        },
        body: JSON.stringify(body),
      }
    );
  }

  async getLatestSnapshot(runId: string) {
    return wrapZodFetch(
      WorkerApiRunLatestSnapshotResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/runs/${runId}/snapshots/latest`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async waitForDuration(
    runId: string,
    snapshotId: string,
    body: WorkerApiWaitForDurationRequestBody
  ) {
    return wrapZodFetch(
      WorkerApiWaitForDurationResponseBody,
      `${this.apiUrl}/api/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/wait/duration`,
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

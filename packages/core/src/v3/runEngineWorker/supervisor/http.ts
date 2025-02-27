import { z } from "zod";
import {
  WorkerApiConnectRequestBody,
  WorkerApiConnectResponseBody,
  WorkerApiContinueRunExecutionRequestBody,
  WorkerApiDequeueRequestBody,
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
  WorkerApiDebugLogBody,
} from "./schemas.js";
import { SupervisorClientCommonOptions } from "./types.js";
import { getDefaultWorkerHeaders } from "./util.js";
import { ApiError, zodfetch } from "../../zodfetch.js";
import { createHeaders } from "../util.js";
import { WORKER_HEADERS } from "../consts.js";

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
      `${this.apiUrl}/engine/v1/worker-actions/connect`,
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

  async dequeue(body: WorkerApiDequeueRequestBody) {
    return wrapZodFetch(
      WorkerApiDequeueResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/dequeue`,
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

  async dequeueFromVersion(deploymentId: string, maxRunCount = 1, runnerId?: string) {
    return wrapZodFetch(
      WorkerApiDequeueResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/deployments/${deploymentId}/dequeue?maxRunCount=${maxRunCount}`,
      {
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
      }
    );
  }

  async heartbeatWorker(body: WorkerApiHeartbeatRequestBody) {
    return wrapZodFetch(
      WorkerApiHeartbeatResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/heartbeat`,
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

  async heartbeatRun(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunHeartbeatRequestBody,
    runnerId?: string
  ) {
    return wrapZodFetch(
      WorkerApiRunHeartbeatResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/heartbeat`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  async startRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunAttemptStartRequestBody,
    runnerId?: string
  ) {
    return wrapZodFetch(
      WorkerApiRunAttemptStartResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
        body: JSON.stringify(body),
      }
    );
  }

  async completeRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunAttemptCompleteRequestBody,
    runnerId?: string
  ) {
    return wrapZodFetch(
      WorkerApiRunAttemptCompleteResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
        body: JSON.stringify(body),
      }
    );
  }

  async getLatestSnapshot(runId: string, runnerId?: string) {
    return wrapZodFetch(
      WorkerApiRunLatestSnapshotResponseBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/latest`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
      }
    );
  }

  async sendDebugLog(runId: string, body: WorkerApiDebugLogBody, runnerId?: string): Promise<void> {
    try {
      const res = await wrapZodFetch(
        z.unknown(),
        `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/logs/debug`,
        {
          method: "POST",
          headers: {
            ...this.defaultHeaders,
            ...this.runnerIdHeader(runnerId),
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

  async continueRunExecution(runId: string, snapshotId: string, runnerId?: string) {
    return wrapZodFetch(
      WorkerApiContinueRunExecutionRequestBody,
      `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/continue`,
      {
        method: "GET",
        headers: {
          ...this.defaultHeaders,
          ...this.runnerIdHeader(runnerId),
        },
      }
    );
  }

  getSuspendCompletionUrl(runId: string, snapshotId: string, runnerId?: string) {
    return {
      url: `${this.apiUrl}/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/suspend`,
      headers: {
        ...this.defaultHeaders,
        ...this.runnerIdHeader(runnerId),
      },
    };
  }

  private runnerIdHeader(runnerId?: string): Record<string, string> {
    return createHeaders({
      [WORKER_HEADERS.RUNNER_ID]: runnerId,
    });
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

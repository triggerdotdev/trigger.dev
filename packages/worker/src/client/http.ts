import { z } from "zod";
import { zodfetch, ApiError } from "@trigger.dev/core/v3/zodfetch";
import {
  WorkerApiConnectResponseBody,
  WorkerApiDequeueResponseBody,
  WorkerApiHeartbeatRequestBody,
  WorkerApiHeartbeatResponseBody,
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptCompleteResponseBody,
  WorkerApiRunAttemptStartResponseBody,
} from "../schemas.js";
import { WorkerClientCommonOptions } from "./types.js";
import { getDefaultHeaders } from "./util.js";

type WorkerHttpClientOptions = WorkerClientCommonOptions;

export class WorkerHttpClient {
  private readonly apiURL: string;
  private readonly workerToken: string;
  private readonly instanceName: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: WorkerHttpClientOptions) {
    this.apiURL = opts.apiUrl.replace(/\/$/, "");
    this.workerToken = opts.workerToken;
    this.instanceName = opts.instanceName;
    this.defaultHeaders = getDefaultHeaders(opts);

    if (!this.apiURL) {
      throw new Error("apiURL is required and needs to be a non-empty string");
    }

    if (!this.workerToken) {
      throw new Error("workerToken is required and needs to be a non-empty string");
    }

    if (!this.instanceName) {
      throw new Error("instanceName is required and needs to be a non-empty string");
    }
  }

  async connect() {
    return wrapZodFetch(
      WorkerApiConnectResponseBody,
      `${this.apiURL}/api/v1/worker-actions/connect`,
      {
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async heartbeat(body: WorkerApiHeartbeatRequestBody) {
    return wrapZodFetch(
      WorkerApiHeartbeatResponseBody,
      `${this.apiURL}/api/v1/worker-actions/heartbeat`,
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
      `${this.apiURL}/api/v1/worker-actions/dequeue`,
      {
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async startRun(runId: string, snapshotId: string) {
    return wrapZodFetch(
      WorkerApiRunAttemptStartResponseBody,
      `${this.apiURL}/api/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
        },
      }
    );
  }

  async completeRun(
    runId: string,
    snapshotId: string,
    body: WorkerApiRunAttemptCompleteRequestBody
  ) {
    return wrapZodFetch(
      WorkerApiRunAttemptCompleteResponseBody,
      `${this.apiURL}/api/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
      {
        method: "POST",
        headers: {
          ...this.defaultHeaders,
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

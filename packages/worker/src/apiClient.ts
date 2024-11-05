import { z } from "zod";
import { zodfetch, ApiError } from "@trigger.dev/core/v3/zodfetch";
import { WorkerApiHeartbeatRequestBody, WorkerApiHeartbeatResponseBody } from "./schemas.js";
import { HEADER_NAME } from "./consts.js";

type WorkerApiClientOptions = {
  apiURL: string;
  workerToken: string;
  instanceName: string;
  deploymentId?: string;
};

export class WorkerApiClient {
  private readonly apiURL: string;
  private readonly workerToken: string;
  private readonly instanceName: string;
  private readonly deploymentId?: string;

  constructor(opts: WorkerApiClientOptions) {
    this.apiURL = opts.apiURL.replace(/\/$/, "");
    this.workerToken = opts.workerToken;
    this.instanceName = opts.instanceName;
    this.deploymentId = opts.deploymentId;

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

  async heartbeat(body: WorkerApiHeartbeatRequestBody) {
    return wrapZodFetch(WorkerApiHeartbeatResponseBody, `${this.apiURL}/api/v1/worker/heartbeat`, {
      method: "POST",
      headers: {
        ...this.defaultHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async dequeue() {
    return wrapZodFetch(WorkerApiHeartbeatResponseBody, `${this.apiURL}/api/v1/worker/heartbeat`, {
      headers: {
        ...this.defaultHeaders,
      },
    });
  }

  private get defaultHeaders(): HeadersInit {
    return {
      Authorization: `Bearer ${this.workerToken}`,
      [HEADER_NAME.WORKER_INSTANCE_NAME]: this.instanceName,
      ...(this.deploymentId && { [HEADER_NAME.WORKER_DEPLOYMENT_ID]: this.deploymentId }),
    };
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

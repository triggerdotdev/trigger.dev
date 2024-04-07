import { context, propagation } from "@opentelemetry/api";
import { ZodFetchOptions, zodfetch } from "../../zodfetch";
import { taskContextManager } from "../tasks/taskContextManager";
import { SafeAsyncLocalStorage } from "../utils/safeAsyncLocalStorage";
import { getEnvVar } from "../utils/getEnv";
import {
  TriggerTaskRequestBody,
  TriggerTaskResponse,
  BatchTriggerTaskRequestBody,
  BatchTriggerTaskResponse,
  CreateUploadPayloadUrlResponseBody,
  ReplayRunResponse,
  CanceledRunResponse,
} from "../schemas";
import { z } from "zod";

export type TriggerOptions = {
  spanParentAsLink?: boolean;
};

const zodFetchOptions: ZodFetchOptions = {
  retry: {
    maxAttempts: 5,
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

  #getHeaders(spanParentAsLink: boolean) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };

    // Only inject the context if we are inside a task
    if (taskContextManager.isInsideTask) {
      propagation.inject(context.active(), headers);

      if (spanParentAsLink) {
        headers["x-trigger-span-parent-as-link"] = "1";
      }
    }

    return headers;
  }
}

type ApiClientContext = {
  baseURL: string;
  accessToken: string;
};

export class ApiClientManager {
  private _storage: SafeAsyncLocalStorage<ApiClientContext> =
    new SafeAsyncLocalStorage<ApiClientContext>();

  get baseURL(): string | undefined {
    const store = this.#getStore();
    return store?.baseURL ?? getEnvVar("TRIGGER_API_URL") ?? "https://api.trigger.dev";
  }

  get accessToken(): string | undefined {
    const store = this.#getStore();
    return store?.accessToken ?? getEnvVar("TRIGGER_SECRET_KEY");
  }

  get client(): ApiClient | undefined {
    if (!this.baseURL || !this.accessToken) {
      return undefined;
    }

    return new ApiClient(this.baseURL, this.accessToken);
  }

  runWith<R extends (...args: any[]) => Promise<any>>(
    context: ApiClientContext,
    fn: R
  ): Promise<ReturnType<R>> {
    return this._storage.runWith(context, fn);
  }

  #getStore(): ApiClientContext | undefined {
    return this._storage.getStore();
  }
}

export const apiClientManager = new ApiClientManager();

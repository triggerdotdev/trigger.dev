import { context, propagation } from "@opentelemetry/api";
import { zodfetch } from "../../zodfetch";
import {
  BatchTriggerTaskRequestBody,
  BatchTriggerTaskResponse,
  GetBatchResponseBody,
  TriggerTaskRequestBody,
  TriggerTaskResponse,
} from "../schemas/api";
import { taskContextManager } from "../tasks/taskContextManager";
import { SafeAsyncLocalStorage } from "../utils/safeAsyncLocalStorage";
import { getEnvVar } from "../utils/getEnv";

/**
 * Trigger.dev v3 API client
 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string
  ) {}

  triggerTask(taskId: string, options: TriggerTaskRequestBody) {
    return zodfetch(TriggerTaskResponse, `${this.baseUrl}/api/v1/tasks/${taskId}/trigger`, {
      method: "POST",
      headers: this.#getHeaders(),
      body: JSON.stringify(options),
    });
  }

  batchTriggerTask(taskId: string, options: BatchTriggerTaskRequestBody) {
    return zodfetch(BatchTriggerTaskResponse, `${this.baseUrl}/api/v1/tasks/${taskId}/batch`, {
      method: "POST",
      headers: this.#getHeaders(),
      body: JSON.stringify(options),
    });
  }

  #getHeaders() {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };

    // Only inject the context if we are inside a task
    if (taskContextManager.isInsideTask) {
      propagation.inject(context.active(), headers);
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
    return store?.baseURL ?? getEnvVar("TRIGGER_API_URL");
  }

  get accessToken(): string | undefined {
    const store = this.#getStore();
    return store?.accessToken ?? getEnvVar("TRIGGER_API_KEY");
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

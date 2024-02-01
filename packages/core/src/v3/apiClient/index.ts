import { context, propagation } from "@opentelemetry/api";
import { zodfetch } from "../../zodfetch";
import { TriggerTaskRequestBody, TriggerTaskResponse } from "../schemas/api";

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

  #getHeaders() {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };

    propagation.inject(context.active(), headers);

    return headers;
  }
}

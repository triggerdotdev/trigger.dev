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
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(options),
    });
  }
}

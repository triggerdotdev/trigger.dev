import { z } from "zod";
import { context, propagation } from "@opentelemetry/api";
import {
  CreateBackgroundWorkerRequestBody,
  CreateBackgroundWorkerResponse,
  CreateImageDetailsRequestBody,
  CreateImageDetailsResponse,
  GetProjectDevResponse,
  TriggerTaskRequestBody,
  TriggerTaskResponse,
  WhoAmIResponseSchema,
} from "../schemas/api";
import { taskContextManager } from "../tasks/taskContextManager";
import {
  CreateAuthorizationCodeResponseSchema,
  GetPersonalAccessTokenResponseSchema,
} from "../schemas";

/**
 * Trigger.dev v3 API client
 */
export class SdkApiClient {
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

    // Only inject the context if we are inside a task
    if (taskContextManager.isInsideTask) {
      propagation.inject(context.active(), headers);
    }

    return headers;
  }
}

export class ApiClient {
  private readonly apiURL: string;

  constructor(
    apiURL: string,
    private readonly accessToken?: string
  ) {
    this.apiURL = apiURL.replace(/\/$/, "");
  }

  async createAuthorizationCode() {
    return zodfetch(
      CreateAuthorizationCodeResponseSchema,
      `${this.apiURL}/api/v1/authorization-code`,
      {
        method: "POST",
      }
    );
  }

  async getPersonalAccessToken(authorizationCode: string) {
    return zodfetch(GetPersonalAccessTokenResponseSchema, `${this.apiURL}/api/v1/token`, {
      method: "POST",
      body: JSON.stringify({
        authorizationCode,
      }),
    });
  }

  async whoAmI() {
    if (!this.accessToken) {
      throw new Error("whoAmI: No access token");
    }

    return zodfetch(WhoAmIResponseSchema, `${this.apiURL}/api/v2/whoami`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async createBackgroundWorker(projectRef: string, body: CreateBackgroundWorkerRequestBody) {
    if (!this.accessToken) {
      throw new Error("createBackgroundWorker: No access token");
    }

    return zodfetch(
      CreateBackgroundWorkerResponse,
      `${this.apiURL}/api/v1/projects/${projectRef}/background-workers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  async createImageDetails(projectRef: string, body: CreateImageDetailsRequestBody) {
    if (!this.accessToken) {
      throw new Error("createImageDetails: No access token");
    }

    return zodfetch(
      CreateImageDetailsResponse,
      `${this.apiURL}/api/v1/projects/${projectRef}/image-details`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  async getProjectDevEnv({ projectRef }: { projectRef: string }) {
    if (!this.accessToken) {
      throw new Error("getProjectDevEnv: No access token");
    }

    return zodfetch(GetProjectDevResponse, `${this.apiURL}/api/v1/projects/${projectRef}/dev`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async getProjectProdEnv({ projectRef }: { projectRef: string }) {
    if (!this.accessToken) {
      throw new Error("getProjectDevEnv: No access token");
    }

    return zodfetch(GetProjectDevResponse, `${this.apiURL}/api/v1/projects/${projectRef}/prod`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }
}

type ApiResult<TSuccessResult> =
  | { success: true; data: TSuccessResult }
  | {
      success: false;
      error: string;
    };

async function zodfetch<TResponseBody extends any>(
  schema: z.Schema<TResponseBody>,
  url: string,
  requestInit?: RequestInit
): Promise<ApiResult<TResponseBody>> {
  try {
    const response = await fetch(url, requestInit);

    if ((!requestInit || requestInit.method === "GET") && response.status === 404) {
      return {
        success: false,
        error: `404: ${response.statusText}`,
      };
    }

    if (response.status >= 400 && response.status < 500) {
      const body = await response.json();
      if (!body.error) {
        return { success: false, error: "Something went wrong" };
      }

      return { success: false, error: body.error };
    }

    if (response.status !== 200) {
      return {
        success: false,
        error: `Failed to fetch ${url}, got status code ${response.status}`,
      };
    }

    const jsonBody = await response.json();
    const parsedResult = schema.safeParse(jsonBody);

    if (parsedResult.success) {
      return { success: true, data: parsedResult.data };
    }

    if ("error" in jsonBody) {
      return {
        success: false,
        error: typeof jsonBody.error === "string" ? jsonBody.error : JSON.stringify(jsonBody.error),
      };
    }

    return { success: false, error: parsedResult.error.message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : JSON.stringify(error),
    };
  }
}

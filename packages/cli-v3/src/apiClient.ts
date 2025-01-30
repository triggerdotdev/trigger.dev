import { z } from "zod";
import { EventSource } from "eventsource";
import {
  CreateAuthorizationCodeResponseSchema,
  GetPersonalAccessTokenResponseSchema,
  WhoAmIResponseSchema,
  CreateBackgroundWorkerRequestBody,
  CreateBackgroundWorkerResponse,
  StartDeploymentIndexingResponseBody,
  GetProjectEnvResponse,
  GetEnvironmentVariablesResponseBody,
  InitializeDeploymentResponseBody,
  InitializeDeploymentRequestBody,
  StartDeploymentIndexingRequestBody,
  GetDeploymentResponseBody,
  GetProjectsResponseBody,
  GetProjectResponseBody,
  ImportEnvironmentVariablesRequestBody,
  EnvironmentVariableResponseBody,
  TaskRunExecution,
  FailDeploymentRequestBody,
  FailDeploymentResponseBody,
  FinalizeDeploymentRequestBody,
  WorkersListResponseBody,
  WorkersCreateResponseBody,
  WorkersCreateRequestBody,
  TriggerTaskRequestBody,
  TriggerTaskResponse,
  GetLatestDeploymentResponseBody,
  DevConfigResponseBody,
  DevDequeueRequestBody,
  DevDequeueResponseBody,
} from "@trigger.dev/core/v3";
import { zodfetch, ApiError } from "@trigger.dev/core/v3/zodfetch";
import { logger } from "./utilities/logger.js";

export class CliApiClient {
  constructor(
    public readonly apiURL: string,
    public readonly accessToken?: string
  ) {
    this.apiURL = apiURL.replace(/\/$/, "");
  }

  async createAuthorizationCode() {
    return wrapZodFetch(
      CreateAuthorizationCodeResponseSchema,
      `${this.apiURL}/api/v1/authorization-code`,
      {
        method: "POST",
      }
    );
  }

  async getPersonalAccessToken(authorizationCode: string) {
    return wrapZodFetch(GetPersonalAccessTokenResponseSchema, `${this.apiURL}/api/v1/token`, {
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

    return wrapZodFetch(WhoAmIResponseSchema, `${this.apiURL}/api/v2/whoami`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async retrieveExternals() {
    return wrapZodFetch(
      z.object({ externals: z.array(z.string()) }),
      `https://jsonhero.io/j/GU7CwoDOL40k.json`,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  async getProject(projectRef: string) {
    if (!this.accessToken) {
      throw new Error("getProject: No access token");
    }

    return wrapZodFetch(GetProjectResponseBody, `${this.apiURL}/api/v1/projects/${projectRef}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async getProjects() {
    if (!this.accessToken) {
      throw new Error("getProjects: No access token");
    }

    return wrapZodFetch(GetProjectsResponseBody, `${this.apiURL}/api/v1/projects`, {
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

    return wrapZodFetch(
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

  async createTaskRunAttempt(runFriendlyId: string) {
    if (!this.accessToken) {
      throw new Error("creatTaskRunAttempt: No access token");
    }

    return wrapZodFetch(TaskRunExecution, `${this.apiURL}/api/v1/runs/${runFriendlyId}/attempts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async getProjectEnv({ projectRef, env }: { projectRef: string; env: string }) {
    if (!this.accessToken) {
      throw new Error("getProjectDevEnv: No access token");
    }

    return wrapZodFetch(
      GetProjectEnvResponse,
      `${this.apiURL}/api/v1/projects/${projectRef}/${env}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
  }

  async getEnvironmentVariables(projectRef: string) {
    if (!this.accessToken) {
      throw new Error("getEnvironmentVariables: No access token");
    }

    return wrapZodFetch(
      GetEnvironmentVariablesResponseBody,
      `${this.apiURL}/api/v1/projects/${projectRef}/envvars`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
  }

  async importEnvVars(
    projectRef: string,
    slug: string,
    params: ImportEnvironmentVariablesRequestBody
  ) {
    if (!this.accessToken) {
      throw new Error("importEnvVars: No access token");
    }

    return wrapZodFetch(
      EnvironmentVariableResponseBody,
      `${this.apiURL}/api/v1/projects/${projectRef}/envvars/${slug}/import`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
      }
    );
  }

  async initializeDeployment(body: InitializeDeploymentRequestBody) {
    if (!this.accessToken) {
      throw new Error("initializeDeployment: No access token");
    }

    return wrapZodFetch(InitializeDeploymentResponseBody, `${this.apiURL}/api/v1/deployments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async createDeploymentBackgroundWorker(
    deploymentId: string,
    body: CreateBackgroundWorkerRequestBody
  ) {
    if (!this.accessToken) {
      throw new Error("createDeploymentBackgroundWorker: No access token");
    }

    return wrapZodFetch(
      CreateBackgroundWorkerResponse,
      `${this.apiURL}/api/v1/deployments/${deploymentId}/background-workers`,
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

  async failDeployment(id: string, body: FailDeploymentRequestBody) {
    if (!this.accessToken) {
      throw new Error("failDeployment: No access token");
    }

    return wrapZodFetch(
      FailDeploymentResponseBody,
      `${this.apiURL}/api/v1/deployments/${id}/fail`,
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

  async finalizeDeployment(id: string, body: FinalizeDeploymentRequestBody) {
    if (!this.accessToken) {
      throw new Error("finalizeDeployment: No access token");
    }

    return wrapZodFetch(
      FailDeploymentResponseBody,
      `${this.apiURL}/api/v1/deployments/${id}/finalize`,
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

  async startDeploymentIndexing(deploymentId: string, body: StartDeploymentIndexingRequestBody) {
    if (!this.accessToken) {
      throw new Error("startDeploymentIndexing: No access token");
    }

    return wrapZodFetch(
      StartDeploymentIndexingResponseBody,
      `${this.apiURL}/api/v1/deployments/${deploymentId}/start-indexing`,
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

  async getDeployment(deploymentId: string) {
    if (!this.accessToken) {
      throw new Error("getDeployment: No access token");
    }

    return wrapZodFetch(
      GetDeploymentResponseBody,
      `${this.apiURL}/api/v1/deployments/${deploymentId}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
      }
    );
  }

  async triggerTaskRun(taskId: string, body?: TriggerTaskRequestBody) {
    if (!this.accessToken) {
      throw new Error("triggerTaskRun: No access token");
    }

    return wrapZodFetch(TriggerTaskResponse, `${this.apiURL}/api/v1/tasks/${taskId}/trigger`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  async devConfig() {
    if (!this.accessToken) {
      throw new Error("devConfig: No access token");
    }

    return wrapZodFetch(DevConfigResponseBody, `${this.apiURL}/api/v1/dev/config`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });
  }

  async devPresenceConnection(): Promise<EventSource> {
    if (!this.accessToken) {
      throw new Error("connectToPresence: No access token");
    }

    const eventSource = new EventSource(`${this.apiURL}/api/v1/dev/presence`, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            Authorization: `Bearer ${this.accessToken}`,
          },
        }),
    });

    return new Promise((resolve, reject) => {
      eventSource.onopen = () => {
        logger.debug("Presence connection established");
        resolve(eventSource);
      };

      eventSource.onerror = (error: any) => {
        // The connection will automatically try to reconnect
        logger.debug("Presence connection error, will automatically attempt to reconnect", {
          error,
          readyState: eventSource.readyState, // 0 = connecting, 1 = open, 2 = closed
        });

        // If you want to detect when it's permanently failed and not reconnecting
        if (eventSource.readyState === EventSource.CLOSED) {
          logger.debug("Presence connection permanently closed", { error });
          reject(new Error(`Failed to connect to ${this.apiURL}`));
        }
      };
    });
  }

  async devDequeue(body: DevDequeueRequestBody) {
    if (!this.accessToken) {
      throw new Error("devConfig: No access token");
    }

    return wrapZodFetch(DevDequeueResponseBody, `${this.apiURL}/api/v1/dev/dequeue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  get workers() {
    return {
      list: this.listWorkers.bind(this),
      create: this.createWorker.bind(this),
    };
  }

  get deployments() {
    return {
      unmanaged: {
        latest: this.getLatestUnmanagedDeployment.bind(this),
      },
    };
  }

  private async getLatestUnmanagedDeployment() {
    if (!this.accessToken) {
      throw new Error("getLatestUnmanagedDeployment: No access token");
    }

    return wrapZodFetch(
      GetLatestDeploymentResponseBody,
      `${this.apiURL}/api/v1/deployments/latest`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
      }
    );
  }

  private async listWorkers() {
    if (!this.accessToken) {
      throw new Error("listWorkers: No access token");
    }

    return wrapZodFetch(WorkersListResponseBody, `${this.apiURL}/api/v1/workers`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });
  }

  private async createWorker(options: WorkersCreateRequestBody) {
    if (!this.accessToken) {
      throw new Error("createWorker: No access token");
    }

    return wrapZodFetch(WorkersCreateResponseBody, `${this.apiURL}/api/v1/workers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify(options),
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

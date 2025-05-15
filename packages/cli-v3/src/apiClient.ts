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
  PromoteDeploymentResponseBody,
  GitMeta,
  UpsertBranchResponseBody,
  UpsertBranchRequestBody,
} from "@trigger.dev/core/v3";
import { ApiResult, wrapZodFetch, zodfetchSSE } from "@trigger.dev/core/v3/zodfetch";
import { logger } from "./utilities/logger.js";
import {
  WorkloadDebugLogRequestBody,
  WorkloadHeartbeatRequestBody,
  WorkloadHeartbeatResponseBody,
  WorkloadRunAttemptCompleteRequestBody,
  WorkloadRunAttemptCompleteResponseBody,
  WorkloadRunAttemptStartResponseBody,
  WorkloadRunLatestSnapshotResponseBody,
} from "@trigger.dev/core/v3/workers";

export class CliApiClient {
  private engineURL: string;

  constructor(
    public readonly apiURL: string,
    // TODO: consider making this required
    public readonly accessToken?: string
  ) {
    this.apiURL = apiURL.replace(/\/$/, "");
    this.engineURL = this.apiURL;
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

  async createTaskRunAttempt(
    runFriendlyId: string
  ): Promise<ApiResult<z.infer<typeof TaskRunExecution>>> {
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

  async getProjectEnv({
    projectRef,
    env,
    branch,
  }: {
    projectRef: string;
    env: string;
    branch?: string;
  }) {
    if (!this.accessToken) {
      throw new Error("getProjectDevEnv: No access token");
    }

    const url = new URL(`api/v1/projects/${projectRef}/${env}`, this.apiURL);
    if (branch) {
      url.searchParams.set("branch", branch);
    }

    return wrapZodFetch(GetProjectEnvResponse, url.toString(), {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async upsertBranch(projectRef: string, body: UpsertBranchRequestBody) {
    if (!this.accessToken) {
      throw new Error("upsertBranch: No access token");
    }

    return wrapZodFetch(
      UpsertBranchResponseBody,
      `${this.apiURL}/api/v1/projects/${projectRef}/branches`,
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

  async finalizeDeployment(
    id: string,
    body: FinalizeDeploymentRequestBody,
    onLog?: (message: string) => void
  ): Promise<ApiResult<FailDeploymentResponseBody>> {
    if (!this.accessToken) {
      throw new Error("finalizeDeployment: No access token");
    }

    let resolvePromise: (value: ApiResult<FailDeploymentResponseBody>) => void;
    let rejectPromise: (reason: any) => void;

    const promise = new Promise<ApiResult<FailDeploymentResponseBody>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const source = zodfetchSSE({
      url: `${this.apiURL}/api/v3/deployments/${id}/finalize`,
      request: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      messages: {
        error: z.object({ error: z.string() }),
        log: z.object({ message: z.string() }),
        complete: FailDeploymentResponseBody,
      },
    });

    source.onConnectionError((error) => {
      rejectPromise({
        success: false,
        error,
      });
    });

    source.onMessage("complete", (message) => {
      resolvePromise({
        success: true,
        data: message,
      });
    });

    source.onMessage("error", ({ error }) => {
      rejectPromise({
        success: false,
        error,
      });
    });

    if (onLog) {
      source.onMessage("log", ({ message }) => {
        onLog(message);
      });
    }

    const result = await promise;

    source.stop();

    return result;
  }

  async promoteDeployment(version: string) {
    if (!this.accessToken) {
      throw new Error("promoteDeployment: No access token");
    }

    return wrapZodFetch(
      PromoteDeploymentResponseBody,
      `${this.apiURL}/api/v1/deployments/${version}/promote`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
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

  get dev() {
    return {
      config: this.devConfig.bind(this),
      presenceConnection: this.devPresenceConnection.bind(this),
      dequeue: this.devDequeue.bind(this),
      sendDebugLog: this.devSendDebugLog.bind(this),
      getRunExecutionData: this.devGetRunExecutionData.bind(this),
      heartbeatRun: this.devHeartbeatRun.bind(this),
      startRunAttempt: this.devStartRunAttempt.bind(this),
      completeRunAttempt: this.devCompleteRunAttempt.bind(this),
      setEngineURL: this.setEngineURL.bind(this),
    } as const;
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

  private async devConfig(): Promise<ApiResult<DevConfigResponseBody>> {
    if (!this.accessToken) {
      throw new Error("devConfig: No access token");
    }

    return wrapZodFetch(DevConfigResponseBody, `${this.engineURL}/engine/v1/dev/config`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
    });
  }

  private devPresenceConnection(): EventSource {
    if (!this.accessToken) {
      throw new Error("connectToPresence: No access token");
    }

    let retryCount = 0;
    const maxRetries = 5;
    const retryDelay = 1000; // Start with 1 second delay

    const eventSource = new EventSource(`${this.engineURL}/engine/v1/dev/presence`, {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            Authorization: `Bearer ${this.accessToken}`,
          },
        }),
    });

    eventSource.onopen = () => {
      logger.debug("Presence connection established");
      retryCount = 0; // Reset retry count on successful connection
    };

    eventSource.onerror = (error: any) => {
      // The connection will automatically try to reconnect
      logger.debug("Presence connection error, will automatically attempt to reconnect", {
        error,
        readyState: eventSource.readyState,
      });

      if (eventSource.readyState === EventSource.CLOSED) {
        logger.debug("Presence connection permanently closed", { error, retryCount });

        if (retryCount < maxRetries) {
          retryCount++;
          const backoffDelay = retryDelay * Math.pow(2, retryCount - 1); // Exponential backoff

          logger.debug(
            `Attempting reconnection in ${backoffDelay}ms (attempt ${retryCount}/${maxRetries})`
          );
          eventSource.close();

          setTimeout(() => {
            this.devPresenceConnection();
          }, backoffDelay);
        } else {
          logger.debug("Max retry attempts reached, giving up");
        }
      }
    };

    return eventSource;
  }

  private async devDequeue(
    body: DevDequeueRequestBody
  ): Promise<ApiResult<DevDequeueResponseBody>> {
    if (!this.accessToken) {
      throw new Error("devConfig: No access token");
    }

    return wrapZodFetch(DevDequeueResponseBody, `${this.engineURL}/engine/v1/dev/dequeue`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private async devSendDebugLog(
    runId: string,
    body: WorkloadDebugLogRequestBody
  ): Promise<ApiResult<unknown>> {
    if (!this.accessToken) {
      throw new Error("devConfig: No access token");
    }

    return wrapZodFetch(z.unknown(), `${this.engineURL}/engine/v1/dev/runs/${runId}/logs/debug`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private async devGetRunExecutionData(
    runId: string
  ): Promise<ApiResult<WorkloadRunLatestSnapshotResponseBody>> {
    return wrapZodFetch(
      WorkloadRunLatestSnapshotResponseBody,
      `${this.engineURL}/engine/v1/dev/runs/${runId}/snapshots/latest`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
      }
    );
  }

  private async devHeartbeatRun(
    runId: string,
    snapshotId: string,
    body: WorkloadHeartbeatRequestBody
  ): Promise<ApiResult<WorkloadHeartbeatResponseBody>> {
    return wrapZodFetch(
      WorkloadHeartbeatResponseBody,
      `${this.engineURL}/engine/v1/dev/runs/${runId}/snapshots/${snapshotId}/heartbeat`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  private async devStartRunAttempt(
    runId: string,
    snapshotId: string
  ): Promise<ApiResult<WorkloadRunAttemptStartResponseBody>> {
    return wrapZodFetch(
      WorkloadRunAttemptStartResponseBody,
      `${this.engineURL}/engine/v1/dev/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
        //no body at the moment, but we'll probably add things soon
        body: JSON.stringify({}),
      }
    );
  }

  private async devCompleteRunAttempt(
    runId: string,
    snapshotId: string,
    body: WorkloadRunAttemptCompleteRequestBody
  ): Promise<ApiResult<WorkloadRunAttemptCompleteResponseBody>> {
    return wrapZodFetch(
      WorkloadRunAttemptCompleteResponseBody,
      `${this.engineURL}/engine/v1/dev/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      }
    );
  }

  private setEngineURL(engineURL: string) {
    this.engineURL = engineURL.replace(/\/$/, "");
  }
}

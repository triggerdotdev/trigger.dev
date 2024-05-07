import { z } from "zod";
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
} from "@trigger.dev/core/v3";

export class CliApiClient {
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

  async getProject(projectRef: string) {
    if (!this.accessToken) {
      throw new Error("getProject: No access token");
    }

    return zodfetch(GetProjectResponseBody, `${this.apiURL}/api/v1/projects/${projectRef}`, {
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

    return zodfetch(GetProjectsResponseBody, `${this.apiURL}/api/v1/projects`, {
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

  async getProjectEnv({
    projectRef,
    env,
  }: {
    projectRef: string;
    env: "dev" | "prod" | "staging";
  }) {
    if (!this.accessToken) {
      throw new Error("getProjectDevEnv: No access token");
    }

    return zodfetch(GetProjectEnvResponse, `${this.apiURL}/api/v1/projects/${projectRef}/${env}`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
    });
  }

  async getEnvironmentVariables(projectRef: string) {
    if (!this.accessToken) {
      throw new Error("getEnvironmentVariables: No access token");
    }

    return zodfetch(
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

  async initializeDeployment(body: InitializeDeploymentRequestBody) {
    if (!this.accessToken) {
      throw new Error("initializeDeployment: No access token");
    }

    return zodfetch(InitializeDeploymentResponseBody, `${this.apiURL}/api/v1/deployments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  async startDeploymentIndexing(deploymentId: string, body: StartDeploymentIndexingRequestBody) {
    if (!this.accessToken) {
      throw new Error("startDeploymentIndexing: No access token");
    }

    return zodfetch(
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

    return zodfetch(
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

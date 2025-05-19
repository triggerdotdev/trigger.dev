import { ApiClient } from "../apiClient/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { getEnvVar } from "../utils/getEnv.js";
import { ApiClientConfiguration } from "./types.js";

const API_NAME = "api-client";

export class ApiClientMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiClientMissingError";
  }
}

export class APIClientManagerAPI {
  private static _instance?: APIClientManagerAPI;

  private constructor() {}

  public static getInstance(): APIClientManagerAPI {
    if (!this._instance) {
      this._instance = new APIClientManagerAPI();
    }

    return this._instance;
  }

  public disable() {
    unregisterGlobal(API_NAME);
  }

  get baseURL(): string | undefined {
    const config = this.#getConfig();
    return config?.baseURL ?? getEnvVar("TRIGGER_API_URL") ?? "https://api.trigger.dev";
  }

  get accessToken(): string | undefined {
    const config = this.#getConfig();
    return (
      config?.secretKey ??
      config?.accessToken ??
      getEnvVar("TRIGGER_SECRET_KEY") ??
      getEnvVar("TRIGGER_ACCESS_TOKEN")
    );
  }

  get branchName(): string | undefined {
    const config = this.#getConfig();
    const value = config?.previewBranch ?? getEnvVar("TRIGGER_PREVIEW_BRANCH") ?? undefined;
    return value ? value : undefined;
  }

  get client(): ApiClient | undefined {
    if (!this.baseURL || !this.accessToken) {
      return undefined;
    }

    return new ApiClient(this.baseURL, this.accessToken, this.branchName);
  }

  clientOrThrow(): ApiClient {
    if (!this.baseURL || !this.accessToken) {
      throw new ApiClientMissingError(this.apiClientMissingError());
    }

    return new ApiClient(this.baseURL, this.accessToken, this.branchName);
  }

  runWithConfig<R extends (...args: any[]) => Promise<any>>(
    config: ApiClientConfiguration,
    fn: R
  ): Promise<ReturnType<R>> {
    const originalConfig = this.#getConfig();
    const $config = { ...originalConfig, ...config };
    registerGlobal(API_NAME, $config, true);

    return fn().finally(() => {
      registerGlobal(API_NAME, originalConfig, true);
    });
  }

  public setGlobalAPIClientConfiguration(config: ApiClientConfiguration): boolean {
    return registerGlobal(API_NAME, config);
  }

  #getConfig(): ApiClientConfiguration | undefined {
    return getGlobal(API_NAME);
  }

  apiClientMissingError() {
    const hasBaseUrl = !!this.baseURL;
    const hasAccessToken = !!this.accessToken;
    if (!hasBaseUrl && !hasAccessToken) {
      return `You need to set the TRIGGER_API_URL and TRIGGER_SECRET_KEY environment variables. See https://trigger.dev/docs/management/overview#authentication`;
    } else if (!hasBaseUrl) {
      return `You need to set the TRIGGER_API_URL environment variable. See https://trigger.dev/docs/management/overview#authentication`;
    } else if (!hasAccessToken) {
      return `You need to set the TRIGGER_SECRET_KEY environment variable. See https://trigger.dev/docs/management/overview#authentication`;
    }

    return `Unknown error`;
  }
}

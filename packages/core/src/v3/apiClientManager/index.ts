import { ApiClient } from "../apiClient/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { getEnvVar } from "../utils/getEnv.js";
import { ApiClientConfiguration } from "./types.js";

const API_NAME = "api-client";

export class ApiClientMissingError extends Error {}

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

  public setGlobalAPIClientConfiguration(config: ApiClientConfiguration): boolean {
    return registerGlobal(API_NAME, config);
  }

  get baseURL(): string | undefined {
    const store = this.#getConfig();
    return store?.baseURL ?? getEnvVar("TRIGGER_API_URL") ?? "https://api.trigger.dev";
  }

  get accessToken(): string | undefined {
    const store = this.#getConfig();
    return store?.secretKey ?? getEnvVar("TRIGGER_SECRET_KEY") ?? getEnvVar("TRIGGER_ACCESS_TOKEN");
  }

  get client(): ApiClient | undefined {
    if (!this.baseURL || !this.accessToken) {
      return undefined;
    }

    return new ApiClient(this.baseURL, this.accessToken);
  }

  clientOrThrow(): ApiClient {
    if (!this.baseURL || !this.accessToken) {
      throw new ApiClientMissingError(this.apiClientMissingError());
    }

    return new ApiClient(this.baseURL, this.accessToken);
  }

  #getConfig(): ApiClientConfiguration | undefined {
    return getGlobal(API_NAME);
  }

  apiClientMissingError() {
    const hasBaseUrl = !!this.baseURL;
    const hasAccessToken = !!this.accessToken;
    if (!hasBaseUrl && !hasAccessToken) {
      return `You need to set the TRIGGER_API_URL and TRIGGER_SECRET_KEY environment variables.`;
    } else if (!hasBaseUrl) {
      return `You need to set the TRIGGER_API_URL environment variable.`;
    } else if (!hasAccessToken) {
      return `You need to set the TRIGGER_SECRET_KEY environment variable.`;
    }

    return `Unknown error`;
  }
}

import { ApiClient } from "../apiClient/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { getEnvVar } from "../utils/getEnv.js";
import { ApiClientConfiguration } from "./types.js";

const API_NAME = "api-client";

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

  #getConfig(): ApiClientConfiguration | undefined {
    return getGlobal(API_NAME);
  }
}

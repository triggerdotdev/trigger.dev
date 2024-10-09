import { ApiClient } from "../apiClient/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { getEnvVar } from "../utils/getEnv.js";
import { ApiClientConfiguration } from "./types.js";
import { SafeAsyncLocalStorage } from "../utils/safeAsyncLocalStorage.js";

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
      config?.secretKey ?? getEnvVar("TRIGGER_SECRET_KEY") ?? getEnvVar("TRIGGER_ACCESS_TOKEN")
    );
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

  runWithConfig<R extends (...args: any[]) => Promise<any>>(
    config: ApiClientConfiguration,
    fn: R
  ): Promise<ReturnType<R>> {
    const asyncLocalStorage = this.#getStorage();

    if (!asyncLocalStorage) {
      throw new ApiClientMissingError(this.apiClientMissingError());
    }

    const currentConfig = asyncLocalStorage.getStore();
    const $config = { ...currentConfig, ...config };

    return asyncLocalStorage.runWith($config, fn);
  }

  public setGlobalAPIClientConfiguration(config: ApiClientConfiguration): boolean {
    const asyncLocalStorage = new SafeAsyncLocalStorage<ApiClientConfiguration>();
    asyncLocalStorage.enterWith(config);

    return registerGlobal(API_NAME, asyncLocalStorage);
  }

  #getStorage(): SafeAsyncLocalStorage<ApiClientConfiguration> | undefined {
    return getGlobal(API_NAME);
  }

  #getConfig(): ApiClientConfiguration | undefined {
    return getGlobal(API_NAME)?.getStore();
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

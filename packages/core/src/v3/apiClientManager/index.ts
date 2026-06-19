import { ApiClient } from "../apiClient/index.js";
import { getGlobal, registerGlobal, unregisterGlobal } from "../utils/globals.js";
import { getEnvVar } from "../utils/getEnv.js";
import { sdkScope } from "../sdkScope/index.js";
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

  private constructor() { }

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
    const scoped = sdkScope.getStore();
    if (scoped) {
      return scoped.apiClientConfig.baseURL ?? "https://api.trigger.dev";
    }
    const config = this.#getConfig();
    return config?.baseURL ?? getEnvVar("TRIGGER_API_URL") ?? "https://api.trigger.dev";
  }

  get accessToken(): string | undefined {
    const scoped = sdkScope.getStore();
    if (scoped) {
      return scoped.apiClientConfig.accessToken ?? scoped.apiClientConfig.secretKey;
    }
    const config = this.#getConfig();
    return (
      config?.secretKey ??
      config?.accessToken ??
      getEnvVar("TRIGGER_SECRET_KEY") ??
      getEnvVar("TRIGGER_ACCESS_TOKEN")
    );
  }

  get branchName(): string | undefined {
    const scoped = sdkScope.getStore();
    if (scoped) {
      // previewBranch carries the branch for any branchable env (preview or dev) —
      // they share the x-trigger-branch header. resolveApiClientConfig folds in the
      // dev-side TRIGGER_DEV_BRANCH carrier when building the scoped config.
      const value = scoped.apiClientConfig.previewBranch;
      return value ? value : undefined;
    }
    const config = this.#getConfig();
    const value =
      config?.previewBranch ??
      getEnvVar("TRIGGER_PREVIEW_BRANCH") ??
      getEnvVar("VERCEL_GIT_COMMIT_REF") ??
      // Dev branches share the x-trigger-branch header; TRIGGER_DEV_BRANCH is the
      // dev-side carrier. Read the raw env var only — never the "default" sentinel.
      getEnvVar("TRIGGER_DEV_BRANCH") ??
      undefined;
    return value ? value : undefined;
  }

  public resolveApiClientConfig(partial: ApiClientConfiguration = {}): ApiClientConfiguration {
    return {
      baseURL: partial.baseURL ?? getEnvVar("TRIGGER_API_URL"),
      accessToken:
        partial.accessToken ??
        partial.secretKey ??
        getEnvVar("TRIGGER_SECRET_KEY") ??
        getEnvVar("TRIGGER_ACCESS_TOKEN"),
      secretKey: partial.secretKey,
      previewBranch:
        partial.previewBranch ??
        getEnvVar("TRIGGER_PREVIEW_BRANCH") ??
        getEnvVar("VERCEL_GIT_COMMIT_REF") ??
        getEnvVar("TRIGGER_DEV_BRANCH"),
      requestOptions: partial.requestOptions,
      future: partial.future,
    };
  }

  get client(): ApiClient | undefined {
    if (!this.baseURL || !this.accessToken) {
      return undefined;
    }

    const scoped = sdkScope.getStore();
    const source = scoped?.apiClientConfig ?? this.#getConfig();
    const requestOptions = source?.requestOptions;
    const futureFlags = source?.future;

    return new ApiClient(this.baseURL, this.accessToken, this.branchName, requestOptions, futureFlags);
  }

  clientOrThrow(config?: ApiClientConfiguration): ApiClient {
    const baseURL = config?.baseURL ?? this.baseURL;
    const accessToken = config?.accessToken ?? config?.secretKey ?? this.accessToken;

    if (!baseURL || !accessToken) {
      throw new ApiClientMissingError(this.apiClientMissingError());
    }

    const branchName = config?.previewBranch ?? this.branchName;
    const scoped = sdkScope.getStore();
    const source = scoped?.apiClientConfig ?? this.#getConfig();
    const requestOptions = config?.requestOptions ?? source?.requestOptions;
    const futureFlags = config?.future ?? source?.future;

    return new ApiClient(baseURL, accessToken, branchName, requestOptions, futureFlags);
  }

  runWithConfig<R extends (...args: any[]) => Promise<any>>(
    config: ApiClientConfiguration,
    fn: R
  ): Promise<ReturnType<R>> {
    const current = sdkScope.getStore()?.apiClientConfig ?? this.#getConfig();
    const merged = this.resolveApiClientConfig({ ...current, ...config });

    if (sdkScope.hasStorage()) {
      return sdkScope.withScope({ apiClientConfig: merged, inheritContext: true }, fn);
    }

    // No ALS available (browser, edge, workers). Fall back to in-place
    // mutation — same as pre-existing behavior, not concurrency-safe.
    const original = this.#getConfig();
    registerGlobal(API_NAME, merged, true);
    return fn().finally(() => {
      registerGlobal(API_NAME, original, true);
    });
  }

  public setGlobalAPIClientConfiguration(config: ApiClientConfiguration): boolean {
    return registerGlobal(API_NAME, config, true);
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

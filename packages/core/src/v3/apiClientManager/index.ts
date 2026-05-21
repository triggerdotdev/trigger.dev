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
    // baseURL is plumbing (where the API lives), not identity. Scoped
    // instances read their own config first but still fall back to the
    // process-level TRIGGER_API_URL so local-dev / CI overrides don't
    // require passing baseURL into every `new TriggerClient(...)`.
    const scoped = sdkScope.getStore();
    if (scoped) {
      return (
        scoped.apiClientConfig.baseURL ??
        getEnvVar("TRIGGER_API_URL") ??
        "https://api.trigger.dev"
      );
    }
    const config = this.#getConfig();
    return config?.baseURL ?? getEnvVar("TRIGGER_API_URL") ?? "https://api.trigger.dev";
  }

  get accessToken(): string | undefined {
    const scoped = sdkScope.getStore();
    if (scoped) {
      const value = scoped.apiClientConfig.accessToken ?? scoped.apiClientConfig.secretKey;
      if (value !== undefined) return value;
      // `inheritContext: true` scopes (e.g. `auth.withAuth` partial
      // overrides) still fall back to the process env so callers who
      // rely on TRIGGER_SECRET_KEY don't lose auth when they only
      // wanted to override baseURL. Isolated scopes (TriggerClient)
      // intentionally do not fall back — the constructor enforces
      // accessToken is provided.
      if (scoped.inheritContext) {
        return getEnvVar("TRIGGER_SECRET_KEY") ?? getEnvVar("TRIGGER_ACCESS_TOKEN");
      }
      return undefined;
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
      const value = scoped.apiClientConfig.previewBranch;
      if (value) return value;
      // Same inheritContext gating as accessToken: withAuth-style
      // scopes inherit env-derived branch; TriggerClient instances
      // stay isolated from process env for identity.
      if (scoped.inheritContext) {
        const envValue =
          getEnvVar("TRIGGER_PREVIEW_BRANCH") ?? getEnvVar("VERCEL_GIT_COMMIT_REF");
        return envValue ? envValue : undefined;
      }
      return undefined;
    }
    const config = this.#getConfig();
    const value =
      config?.previewBranch ??
      getEnvVar("TRIGGER_PREVIEW_BRANCH") ??
      getEnvVar("VERCEL_GIT_COMMIT_REF") ??
      undefined;
    return value ? value : undefined;
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
    const merged: ApiClientConfiguration = { ...this.#getConfig(), ...config };

    // Use the AsyncLocalStorage scope when installed (Node-side code
    // that has loaded TriggerClient or auth) — concurrency-safe.
    if (sdkScope.hasStorage()) {
      return sdkScope.withScope({ apiClientConfig: merged, inheritContext: true }, fn);
    }

    // Fallback: in-place global mutation. Matches pre-existing behavior
    // and works in any runtime (browser, Edge, Workers, Node without
    // the storage installed). Not concurrency-safe — parallel callers
    // with different configs will stomp on each other.
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

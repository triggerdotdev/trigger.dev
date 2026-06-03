import type { ApiClientConfiguration } from "../apiClientManager/types.js";

export type SdkScope = {
  apiClientConfig: ApiClientConfiguration;
  inheritContext: boolean;
};

export type SdkScopeStorage = {
  getStore(): SdkScope | undefined;
  run<R>(scope: SdkScope, fn: () => R): R;
};

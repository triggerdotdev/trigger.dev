import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiClientConfiguration } from "../apiClientManager/types.js";

export type SdkScope = {
  apiClientConfig: ApiClientConfiguration;
  inheritContext: boolean;
};

const storage = new AsyncLocalStorage<SdkScope>();

export const sdkScope = {
  getStore(): SdkScope | undefined {
    return storage.getStore();
  },
  withScope<R>(scope: SdkScope, fn: () => R): R {
    return storage.run(scope, fn);
  },
};

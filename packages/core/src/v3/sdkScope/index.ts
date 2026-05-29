import type { SdkScope, SdkScopeStorage } from "./types.js";

export type { SdkScope, SdkScopeStorage } from "./types.js";

let installedStorage: SdkScopeStorage | undefined;

export function _installSdkScopeStorage(storage: SdkScopeStorage): void {
  installedStorage = storage;
}

export const sdkScope = {
  hasStorage(): boolean {
    return installedStorage !== undefined;
  },
  getStore(): SdkScope | undefined {
    return installedStorage?.getStore();
  },
  withScope<R>(scope: SdkScope, fn: () => R): R {
    return installedStorage ? installedStorage.run(scope, fn) : fn();
  },
};

import type { SdkScope, SdkScopeStorage } from "./types.js";

export type { SdkScope, SdkScopeStorage } from "./types.js";

// Storage slot. Filled at runtime by a Node-only module
// (`@trigger.dev/core/v3/sdk-scope-storage`) that owns the
// AsyncLocalStorage instance. Left undefined in environments that
// never import that module (browsers, edge runtimes), where
// `sdkScope.withScope` falls through to invoking the callback
// directly. `sdkScope/index.ts` deliberately does not statically
// import `node:async_hooks` or `storage-node.ts` so it is safe to
// include in any browser-side bundle that reaches `@trigger.dev/core/v3`.
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

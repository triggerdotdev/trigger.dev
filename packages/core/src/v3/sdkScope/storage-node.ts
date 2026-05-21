import { AsyncLocalStorage } from "node:async_hooks";
import { _installSdkScopeStorage } from "./index.js";
import type { SdkScope } from "./types.js";

// Importing this module installs an AsyncLocalStorage-backed
// `SdkScopeStorage` into the slot exposed by `sdkScope/index.ts`. The
// SDK side-effect-imports this from server-only modules
// (TriggerClient, auth) so that browser-bundled code that never
// touches those modules never pulls `node:async_hooks` either.
const als = new AsyncLocalStorage<SdkScope>();

_installSdkScopeStorage({
  getStore: () => als.getStore(),
  run: (scope, fn) => als.run(scope, fn),
});

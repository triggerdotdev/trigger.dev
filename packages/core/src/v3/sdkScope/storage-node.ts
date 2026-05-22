import { AsyncLocalStorage } from "node:async_hooks";
import { _installSdkScopeStorage } from "./index.js";
import type { SdkScope } from "./types.js";

const als = new AsyncLocalStorage<SdkScope>();

_installSdkScopeStorage({
  getStore: () => als.getStore(),
  run: (scope, fn) => als.run(scope, fn),
});

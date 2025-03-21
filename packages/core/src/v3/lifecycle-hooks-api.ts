// Split module-level variable definition into separate files to allow
// tree-shaking on each api instance.
import { LifecycleHooksAPI } from "./lifecycleHooks/index.js";
/** Entrypoint for runtime API */
export const lifecycleHooks = LifecycleHooksAPI.getInstance();

export type {
  OnInitHookFunction,
  AnyOnInitHookFunction,
  RegisteredHookFunction,
  TaskInitHookParams,
  TaskStartHookParams,
  OnStartHookFunction,
  AnyOnStartHookFunction,
} from "./lifecycleHooks/types.js";

export * as lifecycleHooksAdapters from "./lifecycleHooks/adapters.js";

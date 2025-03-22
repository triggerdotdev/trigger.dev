import {
  lifecycleHooks,
  type AnyOnInitHookFunction,
  type TaskInitHookParams,
  type OnInitHookFunction,
  type AnyOnStartHookFunction,
  type TaskStartHookParams,
  type OnStartHookFunction,
  type AnyOnFailureHookFunction,
} from "@trigger.dev/core/v3";

export type {
  AnyOnInitHookFunction,
  TaskInitHookParams,
  OnInitHookFunction,
  AnyOnStartHookFunction,
  TaskStartHookParams,
  OnStartHookFunction,
  AnyOnFailureHookFunction,
};

export function onInit(name: string, fn: AnyOnInitHookFunction): void;
export function onInit(fn: AnyOnInitHookFunction): void;
export function onInit(fnOrName: string | AnyOnInitHookFunction, fn?: AnyOnInitHookFunction): void {
  lifecycleHooks.registerGlobalInitHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

export function onStart(name: string, fn: AnyOnStartHookFunction): void;
export function onStart(fn: AnyOnStartHookFunction): void;
export function onStart(
  fnOrName: string | AnyOnStartHookFunction,
  fn?: AnyOnStartHookFunction
): void {
  lifecycleHooks.registerGlobalStartHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

export function onFailure(name: string, fn: AnyOnFailureHookFunction): void;
export function onFailure(fn: AnyOnFailureHookFunction): void;
export function onFailure(
  fnOrName: string | AnyOnFailureHookFunction,
  fn?: AnyOnFailureHookFunction
): void {
  lifecycleHooks.registerGlobalFailureHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

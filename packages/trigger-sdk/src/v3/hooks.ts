import {
  lifecycleHooks,
  type AnyOnInitHookFunction,
  type TaskInitHookParams,
  type OnInitHookFunction,
  type AnyOnStartHookFunction,
  type TaskStartHookParams,
  type OnStartHookFunction,
} from "@trigger.dev/core/v3";

export type {
  AnyOnInitHookFunction,
  TaskInitHookParams,
  OnInitHookFunction,
  AnyOnStartHookFunction,
  TaskStartHookParams,
  OnStartHookFunction,
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

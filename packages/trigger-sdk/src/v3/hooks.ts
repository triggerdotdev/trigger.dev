import {
  lifecycleHooks,
  type AnyOnInitHookFunction,
  type TaskInitHookParams,
  type OnInitHookFunction,
} from "@trigger.dev/core/v3";

export type { AnyOnInitHookFunction, TaskInitHookParams, OnInitHookFunction };

export function onInit(name: string, fn: AnyOnInitHookFunction): void;
export function onInit(fn: AnyOnInitHookFunction): void;
export function onInit(fnOrName: string | AnyOnInitHookFunction, fn?: AnyOnInitHookFunction): void {
  lifecycleHooks.registerGlobalInitHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

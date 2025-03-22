import {
  lifecycleHooks,
  type AnyOnInitHookFunction,
  type TaskInitHookParams,
  type OnInitHookFunction,
  type AnyOnStartHookFunction,
  type TaskStartHookParams,
  type OnStartHookFunction,
  type AnyOnFailureHookFunction,
  type AnyOnSuccessHookFunction,
  type AnyOnCompleteHookFunction,
  type TaskCompleteResult,
  type AnyOnWaitHookFunction,
  type AnyOnResumeHookFunction,
} from "@trigger.dev/core/v3";

export type {
  AnyOnInitHookFunction,
  TaskInitHookParams,
  OnInitHookFunction,
  AnyOnStartHookFunction,
  TaskStartHookParams,
  OnStartHookFunction,
  AnyOnFailureHookFunction,
  AnyOnSuccessHookFunction,
  AnyOnCompleteHookFunction,
  TaskCompleteResult,
  AnyOnWaitHookFunction,
  AnyOnResumeHookFunction,
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

export function onSuccess(name: string, fn: AnyOnSuccessHookFunction): void;
export function onSuccess(fn: AnyOnSuccessHookFunction): void;
export function onSuccess(
  fnOrName: string | AnyOnSuccessHookFunction,
  fn?: AnyOnSuccessHookFunction
): void {
  lifecycleHooks.registerGlobalSuccessHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

export function onComplete(name: string, fn: AnyOnCompleteHookFunction): void;
export function onComplete(fn: AnyOnCompleteHookFunction): void;
export function onComplete(
  fnOrName: string | AnyOnCompleteHookFunction,
  fn?: AnyOnCompleteHookFunction
): void {
  lifecycleHooks.registerGlobalCompleteHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

export function onWait(name: string, fn: AnyOnWaitHookFunction): void;
export function onWait(fn: AnyOnWaitHookFunction): void;
export function onWait(fnOrName: string | AnyOnWaitHookFunction, fn?: AnyOnWaitHookFunction): void {
  lifecycleHooks.registerGlobalWaitHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

export function onResume(name: string, fn: AnyOnResumeHookFunction): void;
export function onResume(fn: AnyOnResumeHookFunction): void;
export function onResume(
  fnOrName: string | AnyOnResumeHookFunction,
  fn?: AnyOnResumeHookFunction
): void {
  lifecycleHooks.registerGlobalResumeHook({
    id: typeof fnOrName === "string" ? fnOrName : fnOrName.name ? fnOrName.name : undefined,
    fn: typeof fnOrName === "function" ? fnOrName : fn!,
  });
}

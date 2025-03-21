import { TaskRunContext } from "../schemas/index.js";

export type TaskInitHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal?: AbortSignal;
};

export type OnInitHookFunction<TPayload, TInitOutput extends Record<string, unknown>> = (
  params: TaskInitHookParams<TPayload>
) => TInitOutput | undefined | void | Promise<TInitOutput | undefined | void>;

export type AnyOnInitHookFunction = OnInitHookFunction<unknown, Record<string, unknown>>;

export type RegisterHookFunctionParams<THookFunction extends (params: any) => any> = {
  id?: string;
  fn: THookFunction;
};

export type RegisteredHookFunction<THookFunction extends (params: any) => any> = {
  id: string;
  name?: string;
  fn: THookFunction;
};

export interface LifecycleHooksManager {
  registerGlobalInitHook(hook: RegisterHookFunctionParams<AnyOnInitHookFunction>): void;
  registerTaskInitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnInitHookFunction>
  ): void;
  getTaskInitHook(taskId: string): AnyOnInitHookFunction | undefined;
  getGlobalInitHooks(): RegisteredHookFunction<AnyOnInitHookFunction>[];
}

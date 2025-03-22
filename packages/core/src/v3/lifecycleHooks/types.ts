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

export type TaskStartHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal?: AbortSignal;
};

export type OnStartHookFunction<TPayload> = (
  params: TaskStartHookParams<TPayload>
) => undefined | void | Promise<undefined | void>;

export type AnyOnStartHookFunction = OnStartHookFunction<unknown>;

export type TaskFailureHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  error: unknown;
  signal?: AbortSignal;
};

export type OnFailureHookFunction<TPayload> = (
  params: TaskFailureHookParams<TPayload>
) => undefined | void | Promise<undefined | void>;

export type AnyOnFailureHookFunction = OnFailureHookFunction<unknown>;

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
  registerGlobalStartHook(hook: RegisterHookFunctionParams<AnyOnStartHookFunction>): void;
  registerTaskStartHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnStartHookFunction>
  ): void;
  getTaskStartHook(taskId: string): AnyOnStartHookFunction | undefined;
  getGlobalStartHooks(): RegisteredHookFunction<AnyOnStartHookFunction>[];
  registerGlobalFailureHook(hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>): void;
  registerTaskFailureHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnFailureHookFunction>
  ): void;
  getTaskFailureHook(taskId: string): AnyOnFailureHookFunction | undefined;
  getGlobalFailureHooks(): RegisteredHookFunction<AnyOnFailureHookFunction>[];
}

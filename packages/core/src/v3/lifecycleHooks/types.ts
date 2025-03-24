import { RetryOptions, TaskRunContext } from "../schemas/index.js";
import { HandleErrorResult } from "../types/index.js";

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

export type TaskWaitHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal?: AbortSignal;
};

export type OnWaitHookFunction<TPayload> = (
  params: TaskWaitHookParams<TPayload>
) => undefined | void | Promise<undefined | void>;

export type AnyOnWaitHookFunction = OnWaitHookFunction<unknown>;

export type TaskResumeHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal?: AbortSignal;
};

export type OnResumeHookFunction<TPayload> = (
  params: TaskResumeHookParams<TPayload>
) => undefined | void | Promise<undefined | void>;

export type AnyOnResumeHookFunction = OnResumeHookFunction<unknown>;

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

export type TaskSuccessHookParams<TPayload = unknown, TOutput = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  output: TOutput;
  signal?: AbortSignal;
};

export type OnSuccessHookFunction<TPayload, TOutput> = (
  params: TaskSuccessHookParams<TPayload, TOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnSuccessHookFunction = OnSuccessHookFunction<unknown, unknown>;

export type TaskCompleteSuccessResult<TOutput> = {
  ok: true;
  data: TOutput;
};

export type TaskCompleteErrorResult = {
  ok: false;
  error: unknown;
};

export type TaskCompleteResult<TOutput> =
  | TaskCompleteSuccessResult<TOutput>
  | TaskCompleteErrorResult;

export type TaskCompleteHookParams<TPayload = unknown, TOutput = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  result: TaskCompleteResult<TOutput>;
  signal?: AbortSignal;
};

export type OnCompleteHookFunction<TPayload, TOutput> = (
  params: TaskCompleteHookParams<TPayload, TOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnCompleteHookFunction = OnCompleteHookFunction<unknown, unknown>;

export type RegisterHookFunctionParams<THookFunction extends (params: any) => any> = {
  id?: string;
  fn: THookFunction;
};

export type RegisteredHookFunction<THookFunction extends (params: any) => any> = {
  id: string;
  name?: string;
  fn: THookFunction;
};

export type TaskCatchErrorHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  error: unknown;
  retry?: RetryOptions;
  retryAt?: Date;
  retryDelayInMs?: number;
  signal?: AbortSignal;
};

export type OnCatchErrorHookFunction<TPayload> = (
  params: TaskCatchErrorHookParams<TPayload>
) => HandleErrorResult;

export type AnyOnCatchErrorHookFunction = OnCatchErrorHookFunction<unknown>;

export type TaskMiddlewareHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal?: AbortSignal;
  next: () => Promise<void>;
};

export type OnMiddlewareHookFunction<TPayload> = (
  params: TaskMiddlewareHookParams<TPayload>
) => Promise<void>;

export type AnyOnMiddlewareHookFunction = OnMiddlewareHookFunction<unknown>;

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
  registerGlobalSuccessHook(hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>): void;
  registerTaskSuccessHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnSuccessHookFunction>
  ): void;
  getTaskSuccessHook(taskId: string): AnyOnSuccessHookFunction | undefined;
  getGlobalSuccessHooks(): RegisteredHookFunction<AnyOnSuccessHookFunction>[];
  registerGlobalCompleteHook(hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>): void;
  registerTaskCompleteHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCompleteHookFunction>
  ): void;
  getTaskCompleteHook(taskId: string): AnyOnCompleteHookFunction | undefined;
  getGlobalCompleteHooks(): RegisteredHookFunction<AnyOnCompleteHookFunction>[];
  registerGlobalWaitHook(hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>): void;
  registerTaskWaitHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnWaitHookFunction>
  ): void;
  getTaskWaitHook(taskId: string): AnyOnWaitHookFunction | undefined;
  getGlobalWaitHooks(): RegisteredHookFunction<AnyOnWaitHookFunction>[];
  registerGlobalResumeHook(hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>): void;
  registerTaskResumeHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnResumeHookFunction>
  ): void;
  getTaskResumeHook(taskId: string): AnyOnResumeHookFunction | undefined;
  getGlobalResumeHooks(): RegisteredHookFunction<AnyOnResumeHookFunction>[];
  registerGlobalCatchErrorHook(hook: RegisterHookFunctionParams<AnyOnCatchErrorHookFunction>): void;
  registerTaskCatchErrorHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCatchErrorHookFunction>
  ): void;
  getTaskCatchErrorHook(taskId: string): AnyOnCatchErrorHookFunction | undefined;
  getGlobalCatchErrorHooks(): RegisteredHookFunction<AnyOnCatchErrorHookFunction>[];
  registerGlobalMiddlewareHook(hook: RegisterHookFunctionParams<AnyOnMiddlewareHookFunction>): void;
  registerTaskMiddlewareHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnMiddlewareHookFunction>
  ): void;
  getTaskMiddlewareHook(taskId: string): AnyOnMiddlewareHookFunction | undefined;
  getGlobalMiddlewareHooks(): RegisteredHookFunction<AnyOnMiddlewareHookFunction>[];
}

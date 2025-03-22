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
}

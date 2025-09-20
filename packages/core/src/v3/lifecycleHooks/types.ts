import { RetryOptions, TaskRunContext } from "../schemas/index.js";
import { HandleErrorResult } from "../types/index.js";

export type TaskInitOutput = Record<string, any> | void | undefined;

export type TaskInitHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal: AbortSignal;
};

export type OnInitHookFunction<TPayload, TInitOutput extends TaskInitOutput> = (
  params: TaskInitHookParams<TPayload>
) => TInitOutput | undefined | void | Promise<TInitOutput | undefined | void>;

export type AnyOnInitHookFunction = OnInitHookFunction<unknown, TaskInitOutput>;

export type TaskStartHookParams<
  TPayload = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnStartHookFunction<TPayload, TInitOutput extends TaskInitOutput = TaskInitOutput> = (
  params: TaskStartHookParams<TPayload, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnStartHookFunction = OnStartHookFunction<unknown, TaskInitOutput>;

export type TaskStartAttemptHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal: AbortSignal;
};

export type OnStartAttemptHookFunction<TPayload> = (
  params: TaskStartAttemptHookParams<TPayload>
) => undefined | void | Promise<undefined | void>;

export type AnyOnStartAttemptHookFunction = OnStartAttemptHookFunction<unknown>;

export type TaskWait =
  | {
      type: "duration";
      date: Date;
    }
  | {
      type: "token";
      token: string;
    }
  | {
      type: "task";
      runId: string;
    }
  | {
      type: "batch";
      batchId: string;
      runCount: number;
    };

export type TaskWaitHookParams<
  TPayload = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  wait: TaskWait;
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnWaitHookFunction<TPayload, TInitOutput extends TaskInitOutput = TaskInitOutput> = (
  params: TaskWaitHookParams<TPayload, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnWaitHookFunction = OnWaitHookFunction<unknown, TaskInitOutput>;

export type TaskResumeHookParams<
  TPayload = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  wait: TaskWait;
  payload: TPayload;
  task: string;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnResumeHookFunction<TPayload, TInitOutput extends TaskInitOutput = TaskInitOutput> = (
  params: TaskResumeHookParams<TPayload, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnResumeHookFunction = OnResumeHookFunction<unknown, TaskInitOutput>;

export type TaskFailureHookParams<
  TPayload = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  error: unknown;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnFailureHookFunction<TPayload, TInitOutput extends TaskInitOutput = TaskInitOutput> = (
  params: TaskFailureHookParams<TPayload, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnFailureHookFunction = OnFailureHookFunction<unknown, TaskInitOutput>;

export type TaskSuccessHookParams<
  TPayload = unknown,
  TOutput = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  output: TOutput;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnSuccessHookFunction<
  TPayload,
  TOutput,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = (
  params: TaskSuccessHookParams<TPayload, TOutput, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnSuccessHookFunction = OnSuccessHookFunction<unknown, unknown, TaskInitOutput>;

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

export type TaskCompleteHookParams<
  TPayload = unknown,
  TOutput = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  result: TaskCompleteResult<TOutput>;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnCompleteHookFunction<
  TPayload,
  TOutput,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = (
  params: TaskCompleteHookParams<TPayload, TOutput, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnCompleteHookFunction = OnCompleteHookFunction<unknown, unknown, TaskInitOutput>;

export type RegisterHookFunctionParams<THookFunction extends (params: any) => any> = {
  id?: string;
  fn: THookFunction;
};

export type RegisteredHookFunction<THookFunction extends (params: any) => any> = {
  id: string;
  name?: string;
  fn: THookFunction;
};

export type TaskCatchErrorHookParams<
  TPayload = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  error: unknown;
  retry?: RetryOptions;
  retryAt?: Date;
  retryDelayInMs?: number;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnCatchErrorHookFunction<
  TPayload,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = (params: TaskCatchErrorHookParams<TPayload, TInitOutput>) => HandleErrorResult;

export type AnyOnCatchErrorHookFunction = OnCatchErrorHookFunction<unknown, TaskInitOutput>;

export type TaskMiddlewareHookParams<TPayload = unknown> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal: AbortSignal;
  next: () => Promise<void>;
};

export type OnMiddlewareHookFunction<TPayload> = (
  params: TaskMiddlewareHookParams<TPayload>
) => Promise<void>;

export type AnyOnMiddlewareHookFunction = OnMiddlewareHookFunction<unknown>;

export type TaskCleanupHookParams<
  TPayload = unknown,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  signal: AbortSignal;
  init?: TInitOutput;
};

export type OnCleanupHookFunction<TPayload, TInitOutput extends TaskInitOutput = TaskInitOutput> = (
  params: TaskCleanupHookParams<TPayload, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnCleanupHookFunction = OnCleanupHookFunction<unknown, TaskInitOutput>;

export type TaskCancelHookParams<
  TPayload = unknown,
  TRunOutput = any,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = {
  ctx: TaskRunContext;
  payload: TPayload;
  task: string;
  runPromise: Promise<TRunOutput>;
  init?: TInitOutput;
  signal: AbortSignal;
};

export type OnCancelHookFunction<
  TPayload,
  TRunOutput = any,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
> = (
  params: TaskCancelHookParams<TPayload, TRunOutput, TInitOutput>
) => undefined | void | Promise<undefined | void>;

export type AnyOnCancelHookFunction = OnCancelHookFunction<unknown, unknown, TaskInitOutput>;

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

  registerGlobalStartAttemptHook(
    hook: RegisterHookFunctionParams<AnyOnStartAttemptHookFunction>
  ): void;
  registerTaskStartAttemptHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnStartAttemptHookFunction>
  ): void;
  getTaskStartAttemptHook(taskId: string): AnyOnStartAttemptHookFunction | undefined;
  getGlobalStartAttemptHooks(): RegisteredHookFunction<AnyOnStartAttemptHookFunction>[];

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
  registerGlobalCleanupHook(hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>): void;
  registerTaskCleanupHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCleanupHookFunction>
  ): void;
  getTaskCleanupHook(taskId: string): AnyOnCleanupHookFunction | undefined;
  getGlobalCleanupHooks(): RegisteredHookFunction<AnyOnCleanupHookFunction>[];

  callOnWaitHookListeners(wait: TaskWait): Promise<void>;
  registerOnWaitHookListener(listener: (wait: TaskWait) => Promise<void>): void;

  callOnResumeHookListeners(wait: TaskWait): Promise<void>;
  registerOnResumeHookListener(listener: (wait: TaskWait) => Promise<void>): void;

  registerGlobalCancelHook(hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>): void;
  registerTaskCancelHook(
    taskId: string,
    hook: RegisterHookFunctionParams<AnyOnCancelHookFunction>
  ): void;
  getGlobalCancelHooks(): RegisteredHookFunction<AnyOnCancelHookFunction>[];
  getTaskCancelHook(taskId: string): AnyOnCancelHookFunction | undefined;

  registerOnCancelHookListener(listener: () => Promise<void>): void;
  callOnCancelHookListeners(): Promise<void>;
}

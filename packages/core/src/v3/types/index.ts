import { RetryOptions, TaskMetadata, TaskManifest, TaskRunContext } from "../schemas/index.js";
import { Prettify } from "./utils.js";

export * from "./utils.js";

export type InitOutput = Record<string, any> | void | undefined;

export type RunFnParams<TInitOutput extends InitOutput> = Prettify<{
  /** Metadata about the task, run, attempt, queue, environment, organization, project and batch.  */
  ctx: Context;
  /** If you use the `init` function, this will be whatever you returned. */
  init?: TInitOutput;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration. Can be used to automatically cancel downstream requests */
  signal?: AbortSignal;
}>;

export type MiddlewareFnParams = Prettify<{
  ctx: Context;
  next: () => Promise<void>;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration. Can be used to automatically cancel downstream requests */
  signal?: AbortSignal;
}>;

export type InitFnParams = Prettify<{
  ctx: Context;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration. Can be used to automatically cancel downstream requests */
  signal?: AbortSignal;
}>;

export type StartFnParams = Prettify<{
  ctx: Context;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration. Can be used to automatically cancel downstream requests */
  signal?: AbortSignal;
}>;

export type Context = TaskRunContext;

export type SuccessFnParams<TInitOutput extends InitOutput> = RunFnParams<TInitOutput>;

export type FailureFnParams<TInitOutput extends InitOutput> = RunFnParams<TInitOutput>;

export type HandleErrorFnParams<TInitOutput extends InitOutput> = RunFnParams<TInitOutput> &
  Prettify<{
    retry?: RetryOptions;
    retryAt?: Date;
    retryDelayInMs?: number;
  }>;

export type HandleErrorModificationOptions = {
  skipRetrying?: boolean | undefined;
  retryAt?: Date | undefined;
  retryDelayInMs?: number | undefined;
  retry?: RetryOptions | undefined;
  error?: unknown;
};

export type HandleErrorResult =
  | undefined
  | void
  | HandleErrorModificationOptions
  | Promise<undefined | void | HandleErrorModificationOptions>;

export type HandleErrorArgs = {
  ctx: Context;
  retry?: RetryOptions;
  retryAt?: Date;
  retryDelayInMs?: number;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration. Can be used to automatically cancel downstream requests */
  signal?: AbortSignal;
};

export type HandleErrorFunction = (
  payload: any,
  error: unknown,
  params: HandleErrorArgs
) => HandleErrorResult;

type ResolveEnvironmentVariablesOptions = {
  variables: Record<string, string> | Array<{ name: string; value: string }>;
  override?: boolean;
};

export type ResolveEnvironmentVariablesResult =
  | ResolveEnvironmentVariablesOptions
  | Promise<void | undefined | ResolveEnvironmentVariablesOptions>
  | void
  | undefined;

export type ResolveEnvironmentVariablesParams = {
  projectRef: string;
  environment: string;
  env: Record<string, string>;
};

export type ResolveEnvironmentVariablesFunction = (
  params: ResolveEnvironmentVariablesParams
) => ResolveEnvironmentVariablesResult;

export type TaskMetadataWithFunctions = TaskMetadata & {
  fns: {
    run: (payload: any, params: RunFnParams<any>) => Promise<any>;
    init?: (payload: any, params: InitFnParams) => Promise<InitOutput>;
    cleanup?: (payload: any, params: RunFnParams<any>) => Promise<void>;
    middleware?: (payload: any, params: MiddlewareFnParams) => Promise<void>;
    handleError?: (
      payload: any,
      error: unknown,
      params: HandleErrorFnParams<any>
    ) => HandleErrorResult;
    onSuccess?: (payload: any, output: any, params: SuccessFnParams<any>) => Promise<void>;
    onFailure?: (payload: any, error: unknown, params: FailureFnParams<any>) => Promise<void>;
    onStart?: (payload: any, params: StartFnParams) => Promise<void>;
  };
};

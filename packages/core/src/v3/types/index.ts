import { RetryOptions, TaskMetadataWithFilePath, TaskRunContext } from "../schemas";
import { Prettify } from "./utils";

export * from "./utils";
export * from "./config";

export type InitOutput = Record<string, any> | void | undefined;

export type RunFnParams<TInitOutput extends InitOutput> = Prettify<{
  /** Metadata about the task, run, attempt, queue, environment, organization, project and batch.  */
  ctx: Context;
  /** If you use the `init` function, this will be whatever you returned. */
  init?: TInitOutput;
}>;

export type MiddlewareFnParams = Prettify<{
  ctx: Context;
  next: () => Promise<void>;
}>;

export type InitFnParams = Prettify<{
  ctx: Context;
}>;

export type Context = TaskRunContext;

export type SuccessFnParams<TOutput, TInitOutput extends InitOutput> = RunFnParams<TInitOutput> &
  Prettify<{
    output: TOutput;
  }>;

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
};

export type HandleErrorFunction = (
  payload: any,
  error: unknown,
  params: HandleErrorArgs
) => HandleErrorResult;

export type TaskMetadataWithFunctions = TaskMetadataWithFilePath & {
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
  };
};

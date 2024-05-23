import { RetryOptions, TaskMetadata, TaskMetadataWithFilePath, TaskRunContext } from "../schemas";
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

export type StartFnParams = Prettify<{
  ctx: Context;
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
  environment: "dev" | "staging" | "prod";
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

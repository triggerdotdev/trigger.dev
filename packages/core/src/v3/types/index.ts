import { RetryOptions, TaskRunContext } from "../schemas";
import { Prettify } from "./utils";

export * from "./utils";
export * from "./config";

export type InitOutput = Record<string, any> | void | undefined;

export type RunFnParams<TInitOutput extends InitOutput> = Prettify<{
  ctx: Context;
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

import { TaskOptions } from "../types/index.js";
import {
  AnyOnInitHookFunction,
  AnyOnStartHookFunction,
  AnyOnFailureHookFunction,
  AnyOnSuccessHookFunction,
  AnyOnCatchErrorHookFunction,
  AnyOnMiddlewareHookFunction,
  TaskInitOutput,
  TaskSuccessHookParams,
  TaskFailureHookParams,
  TaskStartHookParams,
  TaskCatchErrorHookParams,
} from "./types.js";

export function createInitHookAdapter<TPayload>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, any>["init"]>
): AnyOnInitHookFunction {
  return async (params) => {
    const paramsWithoutPayload = {
      ...params,
    };

    delete paramsWithoutPayload["payload"];

    return await fn(params.payload as unknown as TPayload, paramsWithoutPayload);
  };
}

export function createStartHookAdapter<
  TPayload,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, TInitOutput>["onStart"]>
): AnyOnStartHookFunction {
  return async (params) => {
    return await fn(
      params.payload as unknown as TPayload,
      params as TaskStartHookParams<TPayload, TInitOutput>
    );
  };
}

export function createFailureHookAdapter<
  TPayload,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, TInitOutput>["onFailure"]>
): AnyOnFailureHookFunction {
  return async (params) => {
    return await fn(
      params.payload as unknown as TPayload,
      params.error,
      params as TaskFailureHookParams<TPayload, TInitOutput>
    );
  };
}

export function createSuccessHookAdapter<TPayload, TOutput, TInitOutput extends TaskInitOutput>(
  fn: NonNullable<TaskOptions<string, TPayload, TOutput, TInitOutput>["onSuccess"]>
): AnyOnSuccessHookFunction {
  return async (params) => {
    return await fn(
      params.payload as unknown as TPayload,
      params.output as unknown as TOutput,
      params as TaskSuccessHookParams<TPayload, TOutput, TInitOutput>
    );
  };
}

export function createHandleErrorHookAdapter<
  TPayload,
  TInitOutput extends TaskInitOutput = TaskInitOutput,
>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, TInitOutput>["handleError"]>
): AnyOnCatchErrorHookFunction {
  return async (params) => {
    return await fn(
      params.payload as unknown as TPayload,
      params.error,
      params as TaskCatchErrorHookParams<TPayload, TInitOutput>
    );
  };
}

export function createMiddlewareHookAdapter<TPayload>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, any>["middleware"]>
): AnyOnMiddlewareHookFunction {
  return async (params) => {
    const { payload, next, ...paramsWithoutPayloadAndNext } = params;

    return await fn(payload as unknown as TPayload, {
      ...paramsWithoutPayloadAndNext,
      next,
    });
  };
}

import { TaskOptions } from "../types/index.js";
import {
  AnyOnInitHookFunction,
  AnyOnStartHookFunction,
  AnyOnFailureHookFunction,
  AnyOnSuccessHookFunction,
  AnyOnCatchErrorHookFunction,
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

export function createStartHookAdapter<TPayload>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, any>["onStart"]>
): AnyOnStartHookFunction {
  return async (params) => {
    const paramsWithoutPayload = {
      ...params,
    };

    delete paramsWithoutPayload["payload"];

    return await fn(params.payload as unknown as TPayload, paramsWithoutPayload);
  };
}

export function createFailureHookAdapter<TPayload>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, any>["onFailure"]>
): AnyOnFailureHookFunction {
  return async (params) => {
    const paramsWithoutPayload = {
      ...params,
    };

    delete paramsWithoutPayload["payload"];
    delete paramsWithoutPayload["error"];

    return await fn(params.payload as unknown as TPayload, params.error, paramsWithoutPayload);
  };
}

export function createSuccessHookAdapter<TPayload, TOutput>(
  fn: NonNullable<TaskOptions<string, TPayload, TOutput, any>["onSuccess"]>
): AnyOnSuccessHookFunction {
  return async (params) => {
    const paramsWithoutPayload = {
      ...params,
    };

    delete paramsWithoutPayload["payload"];
    delete paramsWithoutPayload["output"];

    return await fn(
      params.payload as unknown as TPayload,
      params.output as unknown as TOutput,
      paramsWithoutPayload
    );
  };
}

export function createHandleErrorHookAdapter<TPayload>(
  fn: NonNullable<TaskOptions<string, TPayload, unknown, any>["handleError"]>
): AnyOnCatchErrorHookFunction {
  return async (params) => {
    return await fn(params.payload as unknown as TPayload, params.error, params);
  };
}

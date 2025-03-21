import { TaskOptions } from "../types/index.js";
import { AnyOnInitHookFunction, AnyOnStartHookFunction } from "./types.js";

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

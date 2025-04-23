import { RetrieveRunResponse } from "../schemas/api.js";
import { AnyRunTypes, InferRunTypes } from "./tasks.js";
import { Prettify } from "./utils.js";

export * from "./utils.js";
export * from "./tasks.js";
export * from "./idempotencyKeys.js";
export * from "./tools.js";
export * from "./queues.js";

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

export type RetrieveRunResult<T> = Prettify<
  Omit<RetrieveRunResponse, "output" | "payload"> & {
    output?: InferRunTypes<T>["output"];
    payload?: InferRunTypes<T>["payload"];
  }
>;

export type AnyRetrieveRunResult = RetrieveRunResult<any>;

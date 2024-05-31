import { RunStatus } from "../schemas";
import { BlobLikePart, Uploadable } from "./core";
import { CursorPageParams } from "./pagination";

export interface ImportEnvironmentVariablesParams {
  /**
   * The variables to be imported. If a variable with the same key already exists, it will be overwritten when `override` is `true`.
   *
   * There are two ways to specify the variables:
   *
   * 1. As a record of key-value pairs. e.g. `{ "key1": "value1", "key2": "value2" }`
   * 2. As an "uploadable" object in dotenv format. An uploadable can be a Node readable stream, a string, or a Buffer. You can also pass the return value of a `fetch` call.
   */
  variables: Uploadable | BlobLikePart | Record<string, string>;

  override?: boolean;
}

export interface CreateEnvironmentVariableParams {
  name: string;
  value: string;
}

export interface UpdateEnvironmentVariableParams {
  value: string;
}

export interface ListRunsQueryParams extends CursorPageParams {
  status?: Array<RunStatus> | RunStatus;
  taskIdentifier?: Array<string> | string;
  version?: Array<string> | string;
  bulkAction?: string;
  from?: Date | number;
  to?: Date | number;
  period?: string;
}

export interface ListProjectRunsQueryParams extends CursorPageParams, ListRunsQueryParams {
  env?: Array<"dev" | "staging" | "prod"> | "dev" | "staging" | "prod";
}

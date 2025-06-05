import { RunStatus, WaitpointTokenStatus } from "../schemas/index.js";
import { CursorPageParams } from "./pagination.js";

export interface ImportEnvironmentVariablesParams {
  /**
   * The variables to be imported. If a variable with the same key already exists, it will be overwritten when `override` is `true`.
   *
   * To specify the variables, you can pass them in as a record of key-value pairs. e.g. `{ "key1": "value1", "key2": "value2" }`
   */
  variables: Record<string, string>;
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
  from?: Date | number;
  to?: Date | number;
  period?: string;
  bulkAction?: string;
  tag?: Array<string> | string;
  schedule?: string;
  isTest?: boolean;
  batch?: string;
}

export interface ListProjectRunsQueryParams extends CursorPageParams, ListRunsQueryParams {
  env?: Array<"dev" | "staging" | "prod"> | "dev" | "staging" | "prod";
}

export interface SubscribeToRunsQueryParams {
  tasks?: Array<string> | string;
  tags?: Array<string> | string;
  createdAt?: string;
  skipColumns?: string[];
}

export interface ListWaitpointTokensQueryParams extends CursorPageParams {
  status?: Array<WaitpointTokenStatus> | WaitpointTokenStatus;
  idempotencyKey?: string;
  tags?: Array<string> | string;
  period?: string;
  from?: Date | number;
  to?: Date | number;
}

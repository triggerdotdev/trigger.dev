import { HandleErrorFnParams, HandleErrorResult } from ".";
import { RetryOptions } from "../schemas";

export interface ProjectConfig {
  project: string;
  triggerDirectories?: string | string[];
  triggerUrl?: string;
  retries?: {
    enabledInDev?: boolean;
    default?: RetryOptions;
  };
  handleError?: (
    payload: any,
    error: unknown,
    params: HandleErrorFnParams<any>
  ) => HandleErrorResult;
}

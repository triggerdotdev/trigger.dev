import {
  HandleErrorFnParams,
  HandleErrorResult,
  InitFnParams,
  InitOutput,
  MiddlewareFnParams,
  RunFnParams,
  TaskMetadataWithFilePath,
} from "@trigger.dev/core/v3";

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

export type TaskFile = {
  triggerDir: string;
  filePath: string;
  importPath: string;
  importName: string;
};

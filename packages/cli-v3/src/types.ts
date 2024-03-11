import { TaskMetadataWithFilePath } from "@trigger.dev/core/v3";

export type TaskMetadataWithFunctions = TaskMetadataWithFilePath & {
  fns: {
    run: (payload: any, params: any) => Promise<any>;
    init?: (payload: any, params: any) => Promise<void>;
    cleanup?: (payload: any, params: any) => Promise<void>;
    middleware?: (payload: any, params: any) => Promise<void>;
  };
};

export type TaskFile = {
  triggerDir: string;
  filePath: string;
  importPath: string;
  importName: string;
};

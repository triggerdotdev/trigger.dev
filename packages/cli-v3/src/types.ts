import { TaskMetadataWithFilePath } from "@trigger.dev/core/v3";

export type TaskMetadataWithFunctions = TaskMetadataWithFilePath & {
  fns: {
    run: (params: any) => Promise<any>;
    init?: (params: any) => Promise<void>;
    cleanup?: (params: any) => Promise<void>;
    middleware?: (params: any) => Promise<void>;
  };
};

export type TaskFile = {
  triggerDir: string;
  filePath: string;
  importPath: string;
  importName: string;
};

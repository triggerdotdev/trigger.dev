import { TaskMetadataWithFilePath } from "@trigger.dev/core/v3";

export type TaskMetadataWithRun = TaskMetadataWithFilePath & {
  run: (params: any) => Promise<any>;
};

export type TaskFile = {
  triggerDir: string;
  filePath: string;
  importPath: string;
  importName: string;
};

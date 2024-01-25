import { TaskMetadataWithFilePath } from "@trigger.dev/core/v3";

export type TaskMetadataWithRun = TaskMetadataWithFilePath & {
  run: (params: any) => Promise<any>;
};

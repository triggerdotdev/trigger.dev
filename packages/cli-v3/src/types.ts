import { TaskMetadataWithFilePath } from "./dev/schemas";

export type TaskMetadataWithRun = TaskMetadataWithFilePath & {
  run: (params: any) => Promise<any>;
};

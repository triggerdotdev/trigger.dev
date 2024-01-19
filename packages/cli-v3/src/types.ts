import { TaskMetadataWithFilePath } from "./dev/schemas";

export type TaskMetadataWithRun = TaskMetadataWithFilePath & {
  run: (params: any) => Promise<any>;
};

export type TaskRunCompletion = {
  id: string;
  error?: string;
  output?: any;
};

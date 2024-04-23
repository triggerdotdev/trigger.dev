import { BackgroundWorkerProperties, TaskRunContext } from "../schemas";

export type TaskContext = {
  ctx: TaskRunContext;
  worker: BackgroundWorkerProperties;
};

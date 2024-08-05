import { BackgroundWorkerProperties, TaskRunContext } from "../schemas/index.js";

export type TaskContext = {
  ctx: TaskRunContext;
  worker: BackgroundWorkerProperties;
};

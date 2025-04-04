import { ServerBackgroundWorker, TaskRunContext } from "../schemas/index.js";

export type TaskContext = {
  ctx: TaskRunContext;
  worker: ServerBackgroundWorker;
  isWarmStart?: boolean;
};

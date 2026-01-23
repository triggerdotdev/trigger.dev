import { TaskRunRouter } from "@internal/store";
import { prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";

export const taskRunRouter = singleton("TaskRunRouter", createTaskRunRouter);

export type { TaskRunRouter };

function createTaskRunRouter() {
  return new TaskRunRouter(prisma);
}

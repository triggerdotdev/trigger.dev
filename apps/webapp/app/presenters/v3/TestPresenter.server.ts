import { type RuntimeEnvironmentType, type TaskTriggerSource } from "@trigger.dev/database";
import { sqlDatabaseSchema } from "~/db.server";
import { findCurrentWorkerDeployment } from "~/v3/models/workerDeployment.server";
import { BasePresenter } from "./basePresenter.server";

type TaskListOptions = {
  userId: string;
  projectId: string;
  environmentId: string;
  environmentType: RuntimeEnvironmentType;
};

export type TaskList = Awaited<ReturnType<TestPresenter["call"]>>;
export type TaskListItem = NonNullable<TaskList["tasks"]>[0];

export class TestPresenter extends BasePresenter {
  public async call({ userId, projectId, environmentId, environmentType }: TaskListOptions) {
    const isDev = environmentType === "DEVELOPMENT";
    const tasks = await this.#getTasks(environmentId, isDev);

    return {
      tasks: tasks.map((task) => {
        return {
          id: task.id,
          taskIdentifier: task.slug,
          filePath: task.filePath,
          friendlyId: task.friendlyId,
          triggerSource: task.triggerSource,
        };
      }),
    };
  }

  async #getTasks(envId: string, isDev: boolean) {
    if (isDev) {
      return await this._replica.$queryRaw<
        {
          id: string;
          version: string;
          slug: string;
          filePath: string;
          friendlyId: string;
          triggerSource: TaskTriggerSource;
        }[]
      >`WITH workers AS (
          SELECT
                bw.*,
                ROW_NUMBER() OVER(ORDER BY string_to_array(bw.version, '.')::int[] DESC) AS rn
          FROM
                ${sqlDatabaseSchema}."BackgroundWorker" bw
          WHERE "runtimeEnvironmentId" = ${envId}
        ),
        latest_workers AS (SELECT * FROM workers WHERE rn = 1)
        SELECT bwt.id, version, slug, "filePath", bwt."friendlyId", bwt."triggerSource"
        FROM latest_workers
        JOIN ${sqlDatabaseSchema}."BackgroundWorkerTask" bwt ON bwt."workerId" = latest_workers.id
        ORDER BY slug ASC;`;
    } else {
      const currentDeployment = await findCurrentWorkerDeployment({ environmentId: envId });
      return currentDeployment?.worker?.tasks ?? [];
    }
  }
}

import {
  type RuntimeEnvironment,
  type Organization,
  type RuntimeEnvironmentType,
} from "@trigger.dev/database";
import { QUEUED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { Prisma, sqlDatabaseSchema } from "~/db.server";
import { type Project } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { type User } from "~/models/user.server";
import { engine } from "~/v3/runEngine.server";
import { concurrencyTracker } from "~/v3/services/taskRunConcurrencyTracker.server";
import { BasePresenter } from "./basePresenter.server";

export type Environment = Awaited<ReturnType<QueuePresenter["environmentConcurrency"]>>;

export class QueuePresenter extends BasePresenter {
  public async call({
    userId,
    projectId,
    organizationId,
    environmentSlug,
  }: {
    userId: User["id"];
    projectId: Project["id"];
    organizationId: Organization["id"];
    environmentSlug: RuntimeEnvironment["slug"];
  }) {
    const environment = await findEnvironmentBySlug(projectId, environmentSlug, userId);
    if (!environment) {
      throw new Error(`Environment not found: ${environmentSlug}`);
    }

    return {
      environment: this.environmentConcurrency(organizationId, projectId, userId, environment),
    };
  }

  async environmentConcurrency(
    organizationId: string,
    projectId: string,
    userId: string,
    environment: { id: string; type: RuntimeEnvironmentType; maximumConcurrencyLimit: number }
  ) {
    const engineV1Concurrency = await concurrencyTracker.environmentConcurrentRunCounts(projectId, [
      environment.id,
    ]);

    const engineV2Concurrency = await engine.currentConcurrencyOfEnvQueue({
      ...environment,
      project: {
        id: projectId,
      },
      organization: {
        id: organizationId,
      },
    });

    const executing = (engineV1Concurrency[environment.id] ?? 0) + engineV2Concurrency;

    const queued = await this._replica.$queryRaw<
      {
        count: BigInt;
      }[]
    >`
SELECT
    COUNT(*)
FROM
    ${sqlDatabaseSchema}."TaskRun" as tr
WHERE
    tr."projectId" = ${projectId}
    AND tr."runtimeEnvironmentId" = ${environment.id}
    AND tr."status" = ANY(ARRAY[${Prisma.join(QUEUED_STATUSES)}]::\"TaskRunStatus\"[])
GROUP BY
    tr."runtimeEnvironmentId";`;

    return {
      concurrency: executing,
      queued: Number(queued.at(0)?.count ?? 0),
      concurrencyLimit: environment.maximumConcurrencyLimit,
    };
  }
}

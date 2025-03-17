import { QUEUED_STATUSES } from "~/components/runs/v3/TaskRunStatus";
import { Prisma, sqlDatabaseSchema } from "~/db.server";
import { type Project } from "~/models/project.server";
import {
  displayableEnvironment,
  type DisplayableInputEnvironment,
} from "~/models/runtimeEnvironment.server";
import { type User } from "~/models/user.server";
import { filterOrphanedEnvironments, sortEnvironments } from "~/utils/environmentSort";
import { concurrencyTracker } from "~/v3/services/taskRunConcurrencyTracker.server";
import { BasePresenter } from "./basePresenter.server";
import { execute } from "effect/Stream";
import { engine } from "~/v3/runEngine.server";

export type Environment = Awaited<
  ReturnType<ConcurrencyPresenter["environmentConcurrency"]>
>[number];

export class ConcurrencyPresenter extends BasePresenter {
  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const project = await this._replica.project.findFirst({
      select: {
        id: true,
        organizationId: true,
        environments: {
          select: {
            id: true,
            apiKey: true,
            pkApiKey: true,
            type: true,
            slug: true,
            updatedAt: true,
            orgMember: {
              select: {
                user: { select: { id: true, name: true, displayName: true } },
              },
            },
            maximumConcurrencyLimit: true,
          },
        },
      },
      where: {
        slug: projectSlug,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }

    return {
      environments: this.environmentConcurrency(
        project.organizationId,
        project.id,
        userId,
        filterOrphanedEnvironments(project.environments)
      ),
    };
  }

  async environmentConcurrency(
    organizationId: string,
    projectId: string,
    userId: string,
    environments: (DisplayableInputEnvironment & { maximumConcurrencyLimit: number })[]
  ) {
    const engineV1Concurrency = await concurrencyTracker.environmentConcurrentRunCounts(
      projectId,
      environments.map((env) => env.id)
    );

    const engineV2Concurrency = await Promise.all(
      environments.map(async (env) =>
        engine.currentConcurrencyOfEnvQueue({
          ...env,
          project: {
            id: projectId,
          },
          organization: {
            id: organizationId,
          },
        })
      )
    );

    //Build `executingCounts` with both v1 and v2 concurrencies
    const executingCounts: Record<string, number> = engineV1Concurrency;

    for (let index = 0; index < environments.length; index++) {
      const env = environments[index];
      const existingValue: number | undefined = executingCounts[env.id];
      executingCounts[env.id] = engineV2Concurrency[index] + (existingValue ?? 0);
    }

    //todo add Run Engine 2 concurrency count

    const queued = await this._replica.$queryRaw<
      {
        runtimeEnvironmentId: string;
        count: BigInt;
      }[]
    >`
SELECT
    "runtimeEnvironmentId",
    COUNT(*)
FROM
    ${sqlDatabaseSchema}."TaskRun" as tr
WHERE
    tr."projectId" = ${projectId}
    AND tr."status" = ANY(ARRAY[${Prisma.join(QUEUED_STATUSES)}]::\"TaskRunStatus\"[])
GROUP BY
    tr."runtimeEnvironmentId";`;

    const sortedEnvironments = sortEnvironments(environments).map((environment) => ({
      ...displayableEnvironment(environment, userId),
      concurrencyLimit: environment.maximumConcurrencyLimit,
      concurrency: executingCounts[environment.id] ?? 0,
      queued: Number(queued.find((q) => q.runtimeEnvironmentId === environment.id)?.count ?? 0),
    }));

    return sortedEnvironments;
  }
}
